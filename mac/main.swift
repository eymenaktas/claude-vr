// Claude Ses Sunucu — menü çubuğunda duran küçük uygulama.
// Quest'teki Claude Ses açılınca 8177'ye "wake" gelir, Whisper (whisper-server, 8178) başlar ve
// Çıkış'a basılana ya da Mac kapanana kadar açık kalır. Ağda "_claudeses._tcp" olarak duyurulur,
// Quest Mac'in IP'sini bilmeden bulur.
import AppKit
import Network

let whisperBin = "/opt/homebrew/bin/whisper-server"
let modelPath = NSString(string: "~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin").expandingTildeInPath
let whisperPort = 8178
let controlPort: NWEndpoint.Port = 8177

enum WState: String { case off, starting, ready }

final class App: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    var toggleLine = NSMenuItem(title: "", action: #selector(toggleWhisper), keyEquivalent: "")
    var lastWakeLine = NSMenuItem(title: "Quest henüz bağlanmadı", action: nil, keyEquivalent: "")
    var proc: Process?
    var listener: NWListener?
    var state: WState = .off { didSet { DispatchQueue.main.async { self.render() } } }

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let url = Bundle.main.url(forResource: "spark", withExtension: "png"), let img = NSImage(contentsOf: url) {
            img.isTemplate = true
            img.size = NSSize(width: 16, height: 16)
            item.button?.image = img
        } else {
            item.button?.title = "✳︎"
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "Claude Ses Sunucu", action: nil, keyEquivalent: "").isEnabled = false
        menu.addItem(stateLine)
        menu.addItem(lastWakeLine)
        menu.addItem(.separator())
        toggleLine.target = self
        menu.addItem(toggleLine)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Çıkış", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        stateLine.isEnabled = false
        lastWakeLine.isEnabled = false
        render()
        startControl()
        // Daha önce başka yoldan açılmış bir whisper-server varsa onu kullan.
        checkReady { ok in if ok { self.state = .ready } }
    }

    func render() {
        let icon = state == .ready ? "🟢" : state == .starting ? "🟡" : "⚪️"
        let text = state == .ready ? "Whisper hazır" : state == .starting ? "Whisper başlıyor…" : "Whisper kapalı (Quest açılınca başlar)"
        stateLine.title = "\(icon) \(text)"
        toggleLine.title = state == .off ? "Whisper'ı şimdi başlat" : "Whisper'ı durdur"
        item.button?.appearsDisabled = state == .off
    }

    // MARK: Whisper süreci

    func startWhisper() {
        guard state == .off else { return }
        guard FileManager.default.fileExists(atPath: whisperBin), FileManager.default.fileExists(atPath: modelPath) else {
            stateLine.title = "⚠️ whisper-server veya model bulunamadı"
            return
        }
        state = .starting
        let p = Process()
        p.executableURL = URL(fileURLWithPath: whisperBin)
        p.arguments = ["-m", modelPath, "--host", "0.0.0.0", "--port", String(whisperPort), "-l", "tr", "-t", "4", "-nt"]
        let logURL = URL(fileURLWithPath: NSString(string: "~/Library/Logs/claude-ses-whisper.log").expandingTildeInPath)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let h = try? FileHandle(forWritingTo: logURL) { p.standardOutput = h; p.standardError = h }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.proc = nil; self?.state = .off }
        }
        do { try p.run(); proc = p } catch { state = .off; return }
        pollReady(tries: 0)
    }

    func pollReady(tries: Int) {
        checkReady { ok in
            if ok { self.state = .ready }
            else if tries < 60 && self.proc != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollReady(tries: tries + 1) } }
        }
    }

    func checkReady(_ done: @escaping (Bool) -> Void) {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(whisperPort)/")!)
        r.timeoutInterval = 1
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func stopWhisper() {
        proc?.terminate()
        proc = nil
        state = .off
    }

    @objc func toggleWhisper() { if state == .off { startWhisper() } else { stopWhisper() } }
    @objc func quit() { stopWhisper(); NSApp.terminate(nil) }
    func applicationWillTerminate(_ n: Notification) { proc?.terminate() }

    // MARK: Kontrol kapısı (8177) + Bonjour

    func startControl() {
        do {
            let l = try NWListener(using: .tcp, on: controlPort)
            l.service = NWListener.Service(name: "Claude Ses", type: "_claudeses._tcp")
            l.newConnectionHandler = { [weak self] c in self?.handle(c) }
            l.start(queue: .main)
            listener = l
        } catch {
            stateLine.title = "⚠️ 8177 kapısı açılamadı"
        }
    }

    func handle(_ c: NWConnection) {
        c.start(queue: .main)
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self else { return }
            let req = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let path = req.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            if path.hasPrefix("/wake") {
                let f = DateFormatter(); f.dateFormat = "HH:mm"
                self.lastWakeLine.title = "Quest bağlandı: \(f.string(from: Date()))"
                if self.state == .off { self.startWhisper() }
            }
            let body = "{\"state\":\"\(self.state.rawValue)\",\"port\":\(whisperPort)}"
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            c.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
