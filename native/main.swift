// TimeAlign for macOS — native app.
// UI + measurement engine: app/index.html (shared with the iPhone page), shown in a WKWebView.
// Audio: Core Audio HAL units, so every Core Audio device (Dante Virtual Soundcard, USB
// interfaces, built-in) and every one of its channels is available — no browser involved.
import Cocoa
import WebKit
import CoreAudio
import AudioToolbox
import AVFoundation

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

// MARK: - Bridge between the web UI and Core Audio

@MainActor
final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    weak var web: WKWebView?
    var player: Player? = nil
    var recorder: Recorder? = nil
    var timer: Timer? = nil
    var seqs = [Int: UnsafeMutablePointer<Float>]()
    let chunk = 2048
    var pendingOpen: [String: Any]? = nil

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
        let dOut = devs.first { $0.id == defOut }?.uid ?? ""
        let dIn = devs.first { $0.id == defIn }?.uid ?? ""
        js("__native.onDevices(\(jsonString(list)), \(jsonString([dOut, dIn])))")
    }

    func closeAudio() {
        timer?.invalidate(); timer = nil
        player?.close(); player = nil
        recorder?.close(); recorder = nil
    }

    func reply(_ o: [String: Any]) { js("__native.onOpen(\(jsonString(o)))") }

    func openAudio(_ body: [String: Any]) {
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

    // <input type="file"> support ("Analyze a recording")
    @objc(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.begin { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // external links open in the default browser
    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
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
        web.uiDelegate = bridge
        web.navigationDelegate = bridge
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
    func applicationWillTerminate(_ notification: Notification) { bridge.closeAudio() }

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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
