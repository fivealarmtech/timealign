// TimeAlign for macOS — native app.
// UI + measurement engine: app/index.html (shared with the iPhone page), shown in a WKWebView.
// Audio: Core Audio HAL units, so every Core Audio device (Dante Virtual Soundcard, USB
// interfaces, built-in) and every one of its channels is available — no browser involved.
import Cocoa
import WebKit
import CoreAudio
import AudioToolbox
import AVFoundation
import Network
import CoreImage
import Security

let SR: Double = 48000
let PERIOD = 32768
let NSEQ = 17

// MARK: - Core Audio helpers

func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: 0)
}

func stringProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var value: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value)
    guard st == noErr, let v = value else { return nil }
    return v.takeRetainedValue() as String
}

func channelCount(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
    var a = addr(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, raw) == noErr else { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    var n = 0
    for b in abl { n += Int(b.mNumberChannels) }
    return n
}

func nominalRate(_ id: AudioObjectID) -> Double {
    var a = addr(kAudioDevicePropertyNominalSampleRate)
    var r = Float64(0)
    var size = UInt32(MemoryLayout<Float64>.size)
    _ = AudioObjectGetPropertyData(id, &a, 0, nil, &size, &r)
    return r
}

func setNominalRate(_ id: AudioObjectID, _ rate: Double) -> Bool {
    if abs(nominalRate(id) - rate) < 1 { return true }
    var a = addr(kAudioDevicePropertyNominalSampleRate)
    var r = Float64(rate)
    if AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float64>.size), &r) != noErr { return false }
    for _ in 0..<50 { if abs(nominalRate(id) - rate) < 1 { return true }; usleep(20000) }
    return abs(nominalRate(id) - rate) < 1
}

func defaultDevice(_ sel: AudioObjectPropertySelector) -> AudioObjectID {
    var a = addr(sel)
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id)
    return id
}

struct Device {
    let id: AudioObjectID
    let uid: String
    let name: String
    let inCh: Int
    let outCh: Int
    let rate: Double
}

func allDevices() -> [Device] {
    var a = addr(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.map { id in
        Device(id: id,
               uid: stringProp(id, kAudioDevicePropertyDeviceUID) ?? "dev-\(id)",
               name: stringProp(id, kAudioObjectPropertyName) ?? "Audio device \(id)",
               inCh: channelCount(id, kAudioObjectPropertyScopeInput),
               outCh: channelCount(id, kAudioObjectPropertyScopeOutput),
               rate: nominalRate(id))
    }
}

struct AudioError: Error { let msg: String }
func check(_ st: OSStatus, _ what: String) throws {
    if st != noErr { throw AudioError(msg: "\(what) failed (Core Audio error \(st))") }
}

func floatFormat(_ channels: Int) -> AudioStreamBasicDescription {
    return AudioStreamBasicDescription(
        mSampleRate: SR, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
        mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
        mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
}

func newHALUnit() throws -> AudioUnit {
    var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                         componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
    guard let comp = AudioComponentFindNext(nil, &desc) else { throw AudioError(msg: "Core Audio HAL unit not found") }
    var unit: AudioUnit? = nil
    try check(AudioComponentInstanceNew(comp, &unit), "Creating audio unit")
    guard let u = unit else { throw AudioError(msg: "Creating audio unit failed") }
    return u
}

// MARK: - Player: every test sequence loops forever, phase-locked to output frame 0; per-sequence
// gain gates (scheduled ramps) and routing to any output channels.

struct GateEvent { var frame: Int64; var target: Float; var ramp: Int }

final class Player {
    var unit: AudioUnit? = nil
    var outCh = 0
    let lock: UnsafeMutablePointer<os_unfair_lock>
    // pending changes from the main thread (guarded by lock)
    var dirty = false
    var pendSeq: [(Int, UnsafeMutablePointer<Float>)] = []
    var pendRoute: [(Int, [Int])] = []
    var pendEvents: [(Int, GateEvent)] = []
    var pendStop = false
    // render-thread state
    var seq = [UnsafeMutablePointer<Float>?](repeating: nil, count: NSEQ)
    var routes = [[Int]](repeating: [], count: NSEQ)
    var events = [[GateEvent]](repeating: [], count: NSEQ)
    var gain = [Float](repeating: 0, count: NSEQ)
    var rampFrom = [Float](repeating: 0, count: NSEQ)
    var rampTo = [Float](repeating: 0, count: NSEQ)
    var rampPos = [Int](repeating: 0, count: NSEQ)
    var rampLen = [Int](repeating: 0, count: NSEQ)
    var frame: Int64 = 0

    init() {
        lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
        pendSeq.reserveCapacity(NSEQ); pendRoute.reserveCapacity(64); pendEvents.reserveCapacity(256)
        for i in 0..<NSEQ { events[i].reserveCapacity(64); routes[i].reserveCapacity(64) }
    }

    func open(device: AudioObjectID, channels: Int) throws {
        let u = try newHALUnit()
        unit = u
        outCh = channels
        var dev = device
        try check(AudioUnitSetProperty(u, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev,
                                       UInt32(MemoryLayout<AudioObjectID>.size)), "Selecting the output device")
        var fmt = floatFormat(channels)
        try check(AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &fmt,
                                       UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "Setting the output format")
        var cb = AURenderCallbackStruct(inputProc: playerRender, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(u, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb,
                                       UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "Setting the output callback")
        try check(AudioUnitInitialize(u), "Starting the output device")
        try check(AudioOutputUnitStart(u), "Starting the output device")
    }

    func close() {
        if let u = unit { AudioOutputUnitStop(u); AudioUnitUninitialize(u); AudioComponentInstanceDispose(u) }
        unit = nil
    }

    private func post(_ f: () -> Void) { os_unfair_lock_lock(lock); f(); dirty = true; os_unfair_lock_unlock(lock) }
    func setSeq(_ id: Int, _ p: UnsafeMutablePointer<Float>) { guard id >= 0 && id < NSEQ else { return }; post { pendSeq.append((id, p)) } }
    func setRoute(_ id: Int, _ chans: [Int]) { guard id >= 0 && id < NSEQ else { return }; post { pendRoute.append((id, chans)) } }
    func addEvent(_ id: Int, _ e: GateEvent) { guard id >= 0 && id < NSEQ else { return }; post { pendEvents.append((id, e)) } }
    func stopAll() { post { pendEvents.removeAll(keepingCapacity: true); pendStop = true } }

    @inline(__always) func startRamp(_ i: Int, _ to: Float, _ len: Int) {
        if len <= 0 { gain[i] = to; rampLen[i] = 0; return }
        rampFrom[i] = gain[i]; rampTo[i] = to; rampPos[i] = 0; rampLen[i] = len
    }

    func render(_ n: Int, _ abl: UnsafeMutableAudioBufferListPointer) {
        for b in abl { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
        if dirty && os_unfair_lock_trylock(lock) {
            for (id, p) in pendSeq { seq[id] = p }
            pendSeq.removeAll(keepingCapacity: true)
            for (id, r) in pendRoute { routes[id] = r }
            pendRoute.removeAll(keepingCapacity: true)
            if pendStop {
                for i in 0..<NSEQ { events[i].removeAll(keepingCapacity: true); startRamp(i, 0, Int(0.03 * SR)) }
                pendStop = false
            }
            for (id, e) in pendEvents { events[id].append(e) }
            pendEvents.removeAll(keepingCapacity: true)
            for i in 0..<NSEQ where events[i].count > 1 { events[i].sort { $0.frame < $1.frame } }
            dirty = false
            os_unfair_lock_unlock(lock)
        }
        let nch = abl.count
        let end = frame + Int64(n)
        for i in 0..<NSEQ {
            guard let s = seq[i] else { continue }
            if gain[i] == 0 && rampLen[i] == 0 && (events[i].isEmpty || events[i][0].frame >= end) { continue }
            let r = routes[i]
            var f = frame
            for k in 0..<n {
                while !events[i].isEmpty && events[i][0].frame <= f {
                    let e = events[i].removeFirst()
                    startRamp(i, e.target, e.ramp)
                }
                if rampLen[i] > 0 {
                    rampPos[i] += 1
                    if rampPos[i] >= rampLen[i] { gain[i] = rampTo[i]; rampLen[i] = 0 }
                    else { gain[i] = rampFrom[i] + (rampTo[i] - rampFrom[i]) * Float(rampPos[i]) / Float(rampLen[i]) }
                }
                let g = gain[i]
                if g != 0 {
                    let v = s[Int(f % Int64(PERIOD))] * g
                    for c in r where c >= 0 && c < nch {
                        if let d = abl[c].mData { d.assumingMemoryBound(to: Float.self)[k] += v }
                    }
                }
                f += 1
            }
        }
        frame = end
    }
}

let playerRender: AURenderCallback = { (refCon, _, _, _, nFrames, ioData) -> OSStatus in
    let p = Unmanaged<Player>.fromOpaque(refCon).takeUnretainedValue()
    if let io = ioData { p.render(Int(nFrames), UnsafeMutableAudioBufferListPointer(io)) }
    return noErr
}

// MARK: - Recorder: any input channel of any device -> ring buffer -> web view in 2048-frame chunks

final class Recorder {
    var unit: AudioUnit? = nil
    var inCh = 0
    var mic = 0
    var ref = -1
    let maxFrames = 8192
    var abl: UnsafeMutableAudioBufferListPointer? = nil
    let ringSize = 48000 * 8
    let ringMic: UnsafeMutablePointer<Float>
    let ringRef: UnsafeMutablePointer<Float>
    let lock: UnsafeMutablePointer<os_unfair_lock>
    var writeIdx: Int64 = 0
    var readIdx: Int64 = 0

    init() {
        ringMic = UnsafeMutablePointer<Float>.allocate(capacity: ringSize); ringMic.initialize(repeating: 0, count: ringSize)
        ringRef = UnsafeMutablePointer<Float>.allocate(capacity: ringSize); ringRef.initialize(repeating: 0, count: ringSize)
        lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1); lock.initialize(to: os_unfair_lock())
    }

    func open(device: AudioObjectID, mic micCh: Int, ref refCh: Int) throws {
        let u = try newHALUnit()
        unit = u
        var one: UInt32 = 1, zero: UInt32 = 0
        try check(AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, 4), "Enabling input")
        try check(AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, 4), "Disabling input-unit output")
        var dev = device
        try check(AudioUnitSetProperty(u, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev,
                                       UInt32(MemoryLayout<AudioObjectID>.size)), "Selecting the input device")
        var dfmt = AudioStreamBasicDescription()
        var sz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &dfmt, &sz), "Reading the input format")
        inCh = Int(dfmt.mChannelsPerFrame)
        if inCh < 1 { throw AudioError(msg: "That device has no inputs.") }
        if abs(dfmt.mSampleRate - SR) > 1 {
            throw AudioError(msg: "The input device is running at \(Int(dfmt.mSampleRate)) Hz. Set it to 48 kHz (Dante Controller for DVS, or Audio MIDI Setup).")
        }
        mic = max(0, min(inCh - 1, micCh))
        ref = refCh >= 0 && refCh < inCh ? refCh : -1
        var cfmt = floatFormat(inCh)
        try check(AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &cfmt,
                                       UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "Setting the input format")
        var maxF = UInt32(maxFrames)
        _ = AudioUnitSetProperty(u, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxF, 4)
        let list = AudioBufferList.allocate(maximumBuffers: inCh)
        for i in 0..<inCh {
            let mem = UnsafeMutableRawPointer.allocate(byteCount: maxFrames * 4, alignment: 16)
            list[i] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(maxFrames * 4), mData: mem)
        }
        abl = list
        var cb = AURenderCallbackStruct(inputProc: recorderInput, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(u, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb,
                                       UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "Setting the input callback")
        try check(AudioUnitInitialize(u), "Starting the input device")
        try check(AudioOutputUnitStart(u), "Starting the input device")
    }

    func close() {
        if let u = unit { AudioOutputUnitStop(u); AudioUnitUninitialize(u); AudioComponentInstanceDispose(u) }
        unit = nil
        if let l = abl { for b in l { b.mData?.deallocate() }; free(l.unsafeMutablePointer) }
        abl = nil
    }

    func pull(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>,
              _ bus: UInt32, _ nFrames: UInt32) -> OSStatus {
        guard let u = unit, let l = abl else { return noErr }
        let n = Int(nFrames)
        if n > maxFrames { return noErr }
        for i in 0..<l.count { l[i].mDataByteSize = UInt32(n * 4) }
        let st = AudioUnitRender(u, flags, ts, bus, nFrames, l.unsafeMutablePointer)
        if st != noErr { return st }
        guard let md = l[mic].mData else { return noErr }
        let m = md.assumingMemoryBound(to: Float.self)
        let rf = (ref >= 0 ? l[ref].mData : nil)?.assumingMemoryBound(to: Float.self) ?? m
        var w = writeIdx
        for k in 0..<n {
            let j = Int(w % Int64(ringSize))
            ringMic[j] = m[k]; ringRef[j] = rf[k]
            w += 1
        }
        os_unfair_lock_lock(lock); writeIdx = w; os_unfair_lock_unlock(lock)
        return noErr
    }

    func written() -> Int64 { os_unfair_lock_lock(lock); let w = writeIdx; os_unfair_lock_unlock(lock); return w }
}

let recorderInput: AURenderCallback = { (refCon, flags, ts, bus, nFrames, _) -> OSStatus in
    let r = Unmanaged<Recorder>.fromOpaque(refCon).takeUnretainedValue()
    return r.pull(flags, ts, bus, nFrames)
}


// MARK: - Live iPhone mic: local certificate authority + HTTPS server
// iOS only allows the microphone on secure (https) pages and rejects untrusted certificates, so
// TimeAlign keeps its own small certificate authority. The iPhone installs that CA once (setup QR),
// after which the live-mic page (served by this Mac over https on the local network) just works.

func localIPv4s() -> [String] {
    var found: [(String, String)] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>? = nil
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
    defer { freeifaddrs(ifaddr) }
    var cur: UnsafeMutablePointer<ifaddrs>? = first
    while let p = cur {
        let flags = Int32(p.pointee.ifa_flags)
        if let sa = p.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
           (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 {
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                let name = String(cString: p.pointee.ifa_name)
                if !ip.hasPrefix("169.254.") && !found.contains(where: { $0.1 == ip }) { found.append((name, ip)) }
            }
        }
        cur = p.pointee.ifa_next
    }
    // Wi-Fi / Ethernet (en*) first
    found.sort { ($0.0.hasPrefix("en") ? 0 : 1, $0.0) < ($1.0.hasPrefix("en") ? 0 : 1, $1.0) }
    return found.map { $0.1 }
}

final class CertManager {
    let dir: URL
    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("TimeAlign/certs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    private func path(_ n: String) -> String { return dir.appendingPathComponent(n).path }

    private func openssl(_ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        p.arguments = args
        p.currentDirectoryURL = dir
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw AudioError(msg: "Certificate setup failed (openssl \(args.first ?? "")): \(String(decoding: out, as: UTF8.self).prefix(300))")
        }
    }

    // Returns the server identity for these SAN entries and the CA certificate (DER) to install on the iPhone.
    func ensure(sans: [String]) throws -> (SecIdentity, Data) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path("ca.key")) || !fm.fileExists(atPath: path("ca.der")) {
            let host = (Host.current().localizedName ?? "Mac").replacingOccurrences(of: "\n", with: " ")
            let cnf = "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = TimeAlign Local CA (\(host))\n[v3_ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n"
            try cnf.write(toFile: path("ca.cnf"), atomically: true, encoding: .utf8)
            try openssl(["genrsa", "-out", "ca.key", "2048"])
            try openssl(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "3650", "-out", "ca.crt", "-config", "ca.cnf", "-extensions", "v3_ca"])
            try openssl(["x509", "-in", "ca.crt", "-outform", "der", "-out", "ca.der"])
            try? fm.removeItem(atPath: path("leaf.p12"))
        }
        let sanLine = sans.joined(separator: ",")
        let oldSan = (try? String(contentsOfFile: path("leaf.san"), encoding: .utf8)) ?? ""
        var age = Double.infinity
        if let attrs = try? fm.attributesOfItem(atPath: path("leaf.p12")), let d = attrs[.creationDate] as? Date { age = Date().timeIntervalSince(d) }
        if oldSan != sanLine || age > 300 * 86400 || !fm.fileExists(atPath: path("leaf.p12")) {
            try makeLeaf(sanLine)
        }
        var result = try loadIdentity()
        if result == nil { try makeLeaf(sanLine); result = try loadIdentity() }
        guard let identity = result else { throw AudioError(msg: "Could not load the TimeAlign certificate.") }
        let caDER = try Data(contentsOf: URL(fileURLWithPath: path("ca.der")))
        return (identity, caDER)
    }

    private func makeLeaf(_ sanLine: String) throws {
        let ext = "basicConstraints = CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = \(sanLine)\n"
        try ext.write(toFile: path("leaf.ext"), atomically: true, encoding: .utf8)
        try openssl(["genrsa", "-out", "leaf.key", "2048"])
        try openssl(["req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=TimeAlign"])
        try openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
                     "-out", "leaf.crt", "-days", "397", "-sha256", "-extfile", "leaf.ext"])
        try? FileManager.default.removeItem(atPath: path("leaf.p12"))
        try openssl(["pkcs12", "-export", "-out", "leaf.p12", "-inkey", "leaf.key", "-in", "leaf.crt", "-certfile", "ca.crt",
                     "-passout", "pass:timealign", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"])
        try sanLine.write(toFile: path("leaf.san"), atomically: true, encoding: .utf8)
    }

    private func loadIdentity() throws -> SecIdentity? {
        let p12 = try Data(contentsOf: URL(fileURLWithPath: path("leaf.p12")))
        var opts: [String: Any] = [kSecImportExportPassphrase as String: "timealign"]
        if #available(macOS 15.0, *) { opts[kSecImportToMemoryOnly as String] = true }
        var items: CFArray? = nil
        let st = SecPKCS12Import(p12 as CFData, opts as CFDictionary, &items)
        guard st == errSecSuccess, let arr = items as? [[String: Any]], let first = arr.first,
              let idRef = first[kSecImportItemIdentity as String] else { return nil }
        return (idRef as! SecIdentity)
    }
}

final class Flag { var value = false }

final class HTTPConn {
    let conn: NWConnection
    let secure: Bool
    weak var server: RemoteServer?
    var buf = Data()
    var closed = false

    init(_ c: NWConnection, secure: Bool, server: RemoteServer) { conn = c; self.secure = secure; self.server = server }

    var peer: String {
        if case let .hostPort(host, _) = conn.endpoint { return "\(host)" }
        return ""
    }

    func start(on queue: DispatchQueue) {
        conn.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed(_), .cancelled: self?.close()
            default: break
            }
        }
        conn.start(queue: queue)
        receive()
    }

    func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let d = data, !d.isEmpty { self.buf.append(d); self.process() }
            if isComplete || error != nil { self.close(); return }
            if !self.closed { self.receive() }
        }
    }

    func close() {
        if closed { return }
        closed = true
        conn.cancel()
        server?.drop(self)
    }

    func process() {
        let sep = Data([13, 10, 13, 10])
        while !closed {
            guard let r = buf.range(of: sep) else {
                if buf.count > 65536 { close() }
                return
            }
            let head = String(decoding: buf.subdata(in: 0..<r.lowerBound), as: UTF8.self)
            let lines = head.components(separatedBy: "\r\n")
            let first = (lines.first ?? "").split(separator: " ")
            if first.count < 2 { close(); return }
            var length = 0
            for line in lines.dropFirst() {
                if let i = line.firstIndex(of: ":"), line[..<i].lowercased() == "content-length" {
                    length = Int(line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
            if length < 0 || length > 4_000_000 { close(); return }
            let bodyStart = r.upperBound
            if buf.count - bodyStart < length { return }
            let body = buf.subdata(in: bodyStart..<(bodyStart + length))
            buf = buf.subdata(in: (bodyStart + length)..<buf.count)
            server?.handle(self, method: String(first[0]), target: String(first[1]), body: body)
        }
    }

    func send(_ status: String, _ type: String, _ body: Data, _ extra: [String: String] = [:]) {
        var head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n"
        for (k, v) in extra { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed({ _ in }))
    }
}

final class RemoteServer {
    let queue = DispatchQueue(label: "timealign.remote")
    var tls: NWListener? = nil
    var http: NWListener? = nil
    var tlsPort: UInt16 = 0
    var httpPort: UInt16 = 0
    let token: String
    var micPage = Data()
    var caDER = Data()
    var liveURL = ""
    var status = "Waiting for TimeAlign…"            // touched on queue only
    var conns: [ObjectIdentifier: HTTPConn] = [:]    // queue only
    var onAudio: (@Sendable (Int64, Data, String) -> Void)? = nil

    init() {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = bytes.map { String(format: "%02x", $0) }.joined()
    }

    func start(identity: SecIdentity, caDER: Data, micPage: Data) throws {
        self.caDER = caDER
        self.micPage = micPage
        let tlsOpts = NWProtocolTLS.Options()
        if let sid = sec_identity_create(identity) { sec_protocol_options_set_local_identity(tlsOpts.securityProtocolOptions, sid) }
        sec_protocol_options_set_min_tls_protocol_version(tlsOpts.securityProtocolOptions, .TLSv12)
        let (t, tp) = try listen(NWParameters(tls: tlsOpts, tcp: NWProtocolTCP.Options()), preferred: 8443, secure: true)
        let (h, hp) = try listen(NWParameters(tls: nil, tcp: NWProtocolTCP.Options()), preferred: 8080, secure: false)
        tls = t; tlsPort = tp; http = h; httpPort = hp
    }

    private func listen(_ params: NWParameters, preferred: UInt16, secure: Bool) throws -> (NWListener, UInt16) {
        params.allowLocalEndpointReuse = true
        for port in [preferred, 0] {
            let l: NWListener
            if port == 0 { l = try NWListener(using: params) }
            else { l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port) ?? .any) }
            let sem = DispatchSemaphore(value: 0)
            let ready = Flag()
            l.stateUpdateHandler = { st in
                switch st {
                case .ready: ready.value = true; sem.signal()
                case .failed(_): sem.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in self?.accept(c, secure: secure) }
            l.start(queue: queue)
            _ = sem.wait(timeout: .now() + 3)
            if ready.value, let p = l.port?.rawValue { return (l, p) }
            l.cancel()
        }
        throw AudioError(msg: "Could not open a network port for the iPhone mic.")
    }

    func accept(_ c: NWConnection, secure: Bool) {
        let h = HTTPConn(c, secure: secure, server: self)
        conns[ObjectIdentifier(h)] = h
        h.start(on: queue)
    }

    func drop(_ h: HTTPConn) { conns[ObjectIdentifier(h)] = nil }

    func setStatus(_ s: String) { queue.async { self.status = s } }

    func stop() {
        tls?.cancel(); http?.cancel(); tls = nil; http = nil
        queue.async { for (_, c) in self.conns { c.conn.cancel() }; self.conns.removeAll() }
    }

    func handle(_ c: HTTPConn, method: String, target: String, body: Data) {
        let parts = target.split(separator: "?", maxSplits: 1)
        let path = parts.isEmpty ? "/" : String(parts[0])
        var q: [String: String] = [:]
        if parts.count > 1 {
            for kv in parts[1].split(separator: "&") {
                let p = kv.split(separator: "=", maxSplits: 1)
                if p.count == 2 { q[String(p[0])] = String(p[1]).removingPercentEncoding ?? String(p[1]) }
            }
        }
        if c.secure {
            if method == "GET" && (path == "/" || path == "/mic") { c.send("200 OK", "text/html; charset=utf-8", micPage); return }
            if method == "POST" && path == "/audio" {
                if q["k"] != token { c.send("403 Forbidden", "text/plain", Data("old QR code".utf8)); return }
                let f = Int64(q["f"] ?? "") ?? -1
                if f >= 0 && body.count >= 2 { onAudio?(f, body, c.peer) }
                let json = (try? JSONSerialization.data(withJSONObject: ["ok": true, "status": status])) ?? Data("{}".utf8)
                c.send("200 OK", "application/json", json)
                return
            }
            c.send("404 Not Found", "text/plain", Data("not found".utf8))
            return
        }
        if path == "/ca.crt" {
            c.send("200 OK", "application/x-x509-ca-cert", caDER, ["Content-Disposition": "attachment; filename=\"TimeAlign-CA.crt\""])
            return
        }
        if path == "/" { c.send("200 OK", "text/html; charset=utf-8", Data(setupPage().utf8)); return }
        c.send("404 Not Found", "text/plain", Data("not found".utf8))
    }

    func setupPage() -> String {
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>TimeAlign iPhone setup</title><style>
        body{margin:0;padding:20px;background:#0e1116;color:#e6edf3;font:16px/1.5 -apple-system,sans-serif}
        h1{font-size:20px} b{color:#ffb547} ol{padding-left:20px} li{margin:10px 0}
        a.btn{display:block;text-align:center;background:#ffb547;color:#1b1300;font-weight:700;padding:16px;border-radius:12px;text-decoration:none;margin:14px 0}
        a.btn2{background:#4fc3f7;color:#001521} .dim{color:#8b98a7;font-size:13px}
        </style></head><body>
        <h1>Set up this iPhone for TimeAlign (one time)</h1>
        <ol>
        <li>Tap <b>Install certificate</b> below, then tap <b>Allow</b>.</li>
        <li>Open <b>Settings</b> → <b>Profile Downloaded</b> (near the top) → <b>Install</b> → enter your passcode → <b>Install</b>.</li>
        <li>Open <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>TimeAlign Local CA</b>.</li>
        <li>Come back and tap <b>Open live mic</b> (or scan the Live mic QR on the Mac).</li>
        </ol>
        <a class="btn" href="/ca.crt">Install certificate</a>
        <a class="btn btn2" href="\(liveURL)">Open live mic</a>
        <p class="dim">The certificate only lets this iPhone trust TimeAlign running on your own Mac.
        After this, just scan the Live mic QR code. Same Wi-Fi network as the Mac is required.</p>
        </body></html>
        """
    }
}

func qrDataURL(_ text: String) -> String {
    guard let f = CIFilter(name: "CIQRCodeGenerator") else { return "" }
    f.setValue(Data(text.utf8), forKey: "inputMessage")
    f.setValue("M", forKey: "inputCorrectionLevel")
    guard let img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return "" }
    let rep = NSBitmapImageRep(ciImage: img)
    guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
    return "data:image/png;base64," + png.base64EncodedString()
}

// MARK: - Bridge between the web UI and Core Audio

@MainActor
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var web: WKWebView?
    var player: Player? = nil
    var recorder: Recorder? = nil
    var timer: Timer? = nil
    var seqs = [Int: UnsafeMutablePointer<Float>]()
    let chunk = 2048
    var pendingOpen: [String: Any]? = nil
    var server: RemoteServer? = nil
    var certs = CertManager()
    var remoteActive = false

    override init() {
        super.init()
        var a = addr(kAudioHardwarePropertyDevices)
        let me = self
        _ = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &a, DispatchQueue.main) { _, _ in
            me.performSelector(onMainThread: #selector(Bridge.devicesChanged), with: nil, waitUntilDone: false)
        }
    }

    @objc func devicesChanged() { js("window.__native && __native.onDevicesChanged && __native.onDevicesChanged()") }
    @objc func tick() { drain() }
    @objc func micGranted() { if let b = pendingOpen { pendingOpen = nil; openAudio(b) } }
    @objc func micDenied() {
        pendingOpen = nil
        reply(["ok": false, "error": "Microphone access was denied. Allow TimeAlign in System Settings → Privacy & Security → Microphone."])
    }

    func js(_ s: String) { web?.evaluateJavaScript(s, completionHandler: nil) }

    func jsonString(_ o: Any) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: []), let s = String(data: d, encoding: .utf8) else { return "null" }
        return s
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "devices": sendDevices()
        case "open": openAudio(body)
        case "close": closeAudio()
        case "seq":
            guard let id = body["id"] as? Int, let b64 = body["data"] as? String, let data = Data(base64Encoded: b64),
                  data.count == PERIOD * 4 else { return }
            let p = seqs[id] ?? UnsafeMutablePointer<Float>.allocate(capacity: PERIOD)
            data.withUnsafeBytes { raw in
                let src = raw.bindMemory(to: Float.self)
                for i in 0..<PERIOD { p[i] = src[i] }
            }
            seqs[id] = p
            player?.setSeq(id, p)
        case "route":
            guard let id = body["id"] as? Int else { return }
            let chans = (body["chans"] as? [Int]) ?? []
            player?.setRoute(id, chans.map { $0 - 1 })
        case "gate":
            guard let id = body["id"] as? Int, let p = player else { return }
            let frame = (body["frame"] as? Double) ?? -1
            let target = (body["target"] as? Double) ?? 0
            let ramp = (body["ramp"] as? Int) ?? 0
            p.addEvent(id, GateEvent(frame: frame < 0 ? 0 : Int64(frame), target: Float(target), ramp: ramp))
        case "stopAll": player?.stopAll()
        case "phoneStatus": if let t = body["text"] as? String { server?.setStatus(t) }
        case "openFile": openFile()
        case "copy":
            if let t = body["text"] as? String { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string) }
        default: break
        }
    }

    func sendDevices() {
        let defOut = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let defIn = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let devs = allDevices()
        let list: [[String: Any]] = devs.map { ["uid": $0.uid, "name": $0.name, "inCh": $0.inCh, "outCh": $0.outCh, "rate": $0.rate] }
        let dOut = devs.first(where: { $0.id == defOut })?.uid ?? ""
        let dIn = devs.first(where: { $0.id == defIn })?.uid ?? ""
        js("__native.onDevices(\(jsonString(list)), \(jsonString([dOut, dIn])))")
    }

    func closeAudio() {
        timer?.invalidate(); timer = nil
        player?.close(); player = nil
        recorder?.close(); recorder = nil
    }

    func reply(_ o: [String: Any]) { js("__native.onOpen(\(jsonString(o)))") }

    func openAudio(_ body: [String: Any]) {
        let wantsRemote = ((body["in"] as? String) ?? "") == "remote"
        if !wantsRemote {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            pendingOpen = body
            let me = self
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                me.performSelector(onMainThread: granted ? #selector(Bridge.micGranted) : #selector(Bridge.micDenied), with: nil, waitUntilDone: false)
            }
            return
        default:
            reply(["ok": false, "error": "Microphone access is off for TimeAlign. Turn it on in System Settings → Privacy & Security → Microphone, then press Restart audio."])
            return
        }
        }
        closeAudio()
        let outUID = (body["out"] as? String) ?? ""
        let inUID = (body["in"] as? String) ?? ""
        let micCh = ((body["micCh"] as? Int) ?? 1) - 1
        let refCh = ((body["refCh"] as? Int) ?? 0) - 1
        let devs = allDevices()
        var result: [String: Any] = ["ok": true]
        do {
            if !outUID.isEmpty {
                guard let d = devs.first(where: { $0.uid == outUID }), d.outCh > 0 else { throw AudioError(msg: "The output device is no longer available. Press Refresh.") }
                _ = setNominalRate(d.id, SR)
                let p = Player()
                try p.open(device: d.id, channels: d.outCh)
                for (id, ptr) in seqs { p.setSeq(id, ptr) }
                player = p
                result["outCh"] = d.outCh; result["outName"] = d.name
            }
            if wantsRemote {
                let info = try startRemote()
                for (k, v) in info { result[k] = v }
                result["inCh"] = 1; result["inName"] = "iPhone (live over Wi-Fi)"; result["micCh"] = 1; result["remote"] = true
                remoteActive = true
                reply(result)
                return
            }
            remoteActive = false
            guard let d = devs.first(where: { $0.uid == inUID }), d.inCh > 0 else { throw AudioError(msg: "Choose an input device (your measurement mic).") }
            _ = setNominalRate(d.id, SR)
            let r = Recorder()
            try r.open(device: d.id, mic: micCh, ref: refCh)
            recorder = r
            result["inCh"] = r.inCh; result["inName"] = d.name; result["micCh"] = r.mic + 1
            timer = Timer.scheduledTimer(timeInterval: 0.02, target: self, selector: #selector(Bridge.tick), userInfo: nil, repeats: true)
        } catch let e as AudioError {
            closeAudio(); result = ["ok": false, "error": e.msg]
        } catch {
            closeAudio(); result = ["ok": false, "error": "\(error)"]
        }
        reply(result)
    }

    func startRemote() throws -> [String: Any] {
        let ips = localIPv4s()
        guard let ip = ips.first else { throw AudioError(msg: "This Mac isn't on a network. Join the same Wi-Fi as the iPhone.") }
        if server == nil {
            var sans = ips.map { "IP:\($0)" } + ["IP:127.0.0.1", "DNS:localhost"]
            let hn = ProcessInfo.processInfo.hostName
            if hn.hasSuffix(".local") { sans.append("DNS:\(hn)") }
            let (identity, caDER) = try certs.ensure(sans: sans)
            var page = Data("<html><body>mic page missing</body></html>".utf8)
            if let u = Bundle.main.url(forResource: "mic", withExtension: "html"), let d = try? Data(contentsOf: u) { page = d }
            let s = RemoteServer()
            s.onAudio = { [weak self] f, data, peer in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.remoteAudio(f, data, peer) } }
            }
            try s.start(identity: identity, caDER: caDER, micPage: page)
            server = s
        }
        guard let s = server else { throw AudioError(msg: "iPhone mic server failed to start.") }
        let live = "https://\(ip):\(s.tlsPort)/?k=\(s.token)"
        let setup = "http://\(ip):\(s.httpPort)/"
        s.liveURL = live
        return ["url": live, "setupUrl": setup, "qr": qrDataURL(live), "qrSetup": qrDataURL(setup), "ip": ip]
    }

    func remoteAudio(_ f: Int64, _ data: Data, _ peer: String) {
        guard remoteActive else { return }
        js("__native.onRemote(\(f),'\(data.base64EncodedString())','\(peer)')")
    }

    func drain() {
        guard let r = recorder else { return }
        let w = r.written()
        if w - r.readIdx > Int64(r.ringSize - 8192) { r.readIdx = w - Int64(chunk * 4) }   // fell behind: skip ahead
        var sent = 0
        while w - r.readIdx >= Int64(chunk) && sent < 16 {
            var m = [Float](repeating: 0, count: chunk), f = [Float](repeating: 0, count: chunk)
            for k in 0..<chunk {
                let j = Int((r.readIdx + Int64(k)) % Int64(r.ringSize))
                m[k] = r.ringMic[j]; f[k] = r.ringRef[j]
            }
            let mb = m.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
            let fb = f.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
            js("__native.onChunk(\(r.readIdx),'\(mb)','\(fb)',\(player?.frame ?? 0))")
            r.readIdx += Int64(chunk)
            sent += 1
        }
    }

    // "Analyze a recording": native open panel, file bytes handed to the page
    func openFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else { return }
        js("__native.onFile(\(jsonString([url.lastPathComponent])), '\(data.base64EncodedString())')")
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let bridge = Bridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "ta")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 940), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        bridge.web = web
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "TimeAlign"
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = NSColor(red: 0.055, green: 0.067, blue: 0.086, alpha: 1)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("TimeAlignMain")
        window.makeKeyAndOrderFront(nil)
        if let res = Bundle.main.resourceURL {
            let page = res.appendingPathComponent("index.html")
            web.loadFileURL(page, allowingReadAccessTo: res)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { return true }
    func applicationWillTerminate(_ notification: Notification) { bridge.closeAudio(); bridge.server?.stop() }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About TimeAlign", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide TimeAlign", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit TimeAlign", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
