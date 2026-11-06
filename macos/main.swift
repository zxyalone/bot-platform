// A native window around the Bot Platform web page. It starts the local daemon if none is running,
// and stops it on quit unless the person asked it to keep running for scheduled routines.
import AppKit
import UserNotifications
import WebKit

let keepRunningKey = "keepDaemonAfterQuit"
let firstPort = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? 4317
var port = firstPort
var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

// A development build points at a checkout and shares its .data; a release build carries its own copy
// of the code and keeps each person's data in their Application Support folder.
let devRoot = ProcessInfo.processInfo.environment["BOT_PLATFORM_ROOT"] ?? Bundle.main.object(forInfoDictionaryKey: "BotPlatformRoot") as? String
let codeRoot = devRoot ?? Bundle.main.resourcePath! + "/app"
let dataHome: String = {
    if let fromEnv = ProcessInfo.processInfo.environment["BOT_PLATFORM_HOME"] { return fromEnv }
    if let dev = devRoot { return dev + "/.data" }
    return NSHomeDirectory() + "/Library/Application Support/Bot Platform"
}()

func run(_ path: String, _ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
}

// Apps opened from Finder get a bare PATH, while the agents live wherever each person installed them.
let loginPath = run("/bin/zsh", ["-lc", "printf %s \"$PATH\""]) ?? ""
func searchPath() -> String {
    let home = NSHomeDirectory()
    let extra = ["\(home)/.npm-global/bin", "\(home)/.local/bin", "\(home)/.volta/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    let current = (loginPath + ":" + (ProcessInfo.processInfo.environment["PATH"] ?? "")).split(separator: ":").map(String.init)
    var seen = Set<String>()
    return (current + extra).filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
}

// Built-in TypeScript and SQLite need Node 22.18 or newer.
func nodeVersion(_ path: String) -> [Int]? {
    guard let v = run(path, ["-p", "process.versions.node"]) else { return nil }
    let parts = v.split(separator: ".").compactMap { Int($0) }
    return parts.count == 3 ? parts : nil
}
func usable(_ v: [Int]) -> Bool { v[0] > 22 || (v[0] == 22 && v[1] >= 18) }

func findNode() -> (path: String?, newestFound: String?) {
    let bundled = Bundle.main.resourcePath! + "/node/bin/node"
    var candidates = [bundled]
    candidates += searchPath().split(separator: ":").map { "\($0)/node" }
    var best: (String, [Int])?
    var newest: [Int]?
    var seen = Set<String>()
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
        let real = (c as NSString).resolvingSymlinksInPath
        guard seen.insert(real).inserted, let v = nodeVersion(c) else { continue }
        if newest == nil || v.lexicographicallyPrecedes(newest!) == false { newest = v }
        if c == bundled && usable(v) { return (c, nil) }
        if usable(v) && (best == nil || best!.1.lexicographicallyPrecedes(v)) { best = (c, v) }
    }
    return (best?.0, newest.map { $0.map(String.init).joined(separator: ".") })
}

enum Probe { case ours, other, free }
// Another program, or another person's Bot Platform on a shared Mac, may already hold the port.
func probe(timeout: TimeInterval = 1) -> Probe {
    var request = URLRequest(url: baseURL.appendingPathComponent("api/settings"))
    request.timeoutInterval = timeout
    let done = DispatchSemaphore(value: 0)
    var result = Probe.free
    URLSession.shared.dataTask(with: request) { data, response, error in
        if error == nil {
            let home = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["home"] as? String
            let same = home.map { URL(fileURLWithPath: $0).standardizedFileURL.path == URL(fileURLWithPath: dataHome).standardizedFileURL.path } ?? false
            result = (response as? HTTPURLResponse)?.statusCode == 200 && same ? .ours : .other
        }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + timeout + 0.5)
    return result
}
func daemonAlive() -> Bool { probe() == .ours }

// Pages call the browser Notification API; WKWebView on macOS has none, so this stands in for it.
let notificationShim = """
(() => {
  class NativeNotification {
    static permission = "granted";
    static requestPermission(cb) { cb && cb("granted"); return Promise.resolve("granted"); }
    constructor(title, options = {}) {
      this.title = title; this.body = options.body || ""; this.onclick = null;
      window.webkit.messageHandlers.notify.postMessage({ title: String(title), body: String(this.body), tag: String(options.tag || "") });
    }
    close() {}
  }
  window.Notification = NativeNotification;
  document.documentElement.dataset.shell = "mac";
})();
"""

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var daemon: Process?
    var logHandle: FileHandle?
    var keepItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        showStatus("正在启动 Bot 平台…", detail: "")
        DispatchQueue.global().async { self.startDaemonIfNeeded() }
    }

    // ---------- daemon ----------
    func startDaemonIfNeeded() {
        port = firstPort
        while port < firstPort + 20 {
            switch probe() {
            case .ours: return DispatchQueue.main.async { self.loadApp() }
            case .free: break
            case .other: port += 1; continue
            }
            break
        }
        let root = codeRoot
        guard FileManager.default.fileExists(atPath: "\(root)/src/daemon/main.ts") else {
            return DispatchQueue.main.async { self.showStatus("找不到 Bot 平台的代码", detail: "应在 \(root)。项目移动过的话，请在新位置重新运行 macos/build.sh。") }
        }
        let found = findNode()
        guard let node = found.path else {
            let seen = found.newestFound.map { "这台电脑上最新的是 \($0)。" } ?? "这台电脑上没有找到 Node.js。"
            return DispatchQueue.main.async { self.showStatus("需要 Node.js 22.18 或更新版本", detail: "\(seen)从 nodejs.org 安装新版后重新打开这个 App。") }
        }
        try? FileManager.default.createDirectory(atPath: dataHome, withIntermediateDirectories: true)
        let logDir = "\(NSHomeDirectory())/Library/Logs/BotPlatform"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = "\(logDir)/daemon.log"
        if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
        logHandle = FileHandle(forWritingAtPath: logPath)
        logHandle?.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--disable-warning=ExperimentalWarning", "src/daemon/main.ts"]
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = searchPath()
        env["PORT"] = String(port)
        env["BOT_PLATFORM_HOME"] = dataHome
        p.environment = env
        p.standardOutput = logHandle
        p.standardError = logHandle
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.daemon === proc else { return }
                self.daemon = nil
                self.showStatus("Bot 平台的后台进程退出了（\(proc.terminationStatus)）", detail: "日志在 \(logPath)。按 ⌘R 重新启动。")
            }
        }
        do { try p.run() } catch {
            return DispatchQueue.main.async { self.showStatus("无法启动后台进程", detail: error.localizedDescription) }
        }
        DispatchQueue.main.sync { self.daemon = p }
        for _ in 0..<60 {
            if daemonAlive() { return DispatchQueue.main.async { self.loadApp() } }
            if !p.isRunning { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
        DispatchQueue.main.async { self.showStatus("后台进程启动太慢", detail: "日志在 \(logPath)。") }
    }

    func stopDaemon() {
        guard let p = daemon, p.isRunning else { return }
        daemon = nil
        p.terminate()
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    }

    // ---------- window ----------
    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "notify")
        config.userContentController.add(self, name: "theme")
        config.userContentController.addUserScript(WKUserScript(source: notificationShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Bot Platform"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1)
        window.minSize = NSSize(width: 760, height: 520)
        window.contentView = webView
        window.setFrameAutosaveName("BotPlatformMain")
        if !window.setFrameUsingName("BotPlatformMain") { window.center() }
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
    }

    func loadApp() {
        webView.load(URLRequest(url: baseURL))
    }

    func showStatus(_ title: String, detail: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <html><body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:#111113;color:#e8e8e6;font:15px -apple-system,'PingFang SC',sans-serif">
        <div><div style="font-size:17px;font-weight:600;margin-bottom:8px">\(esc(title))</div><div style="color:#9a9a96;max-width:520px">\(esc(detail))</div></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    @objc func reload(_ sender: Any?) {
        if daemonAlive() { webView.reload() } else {
            showStatus("正在启动 Bot 平台…", detail: "")
            DispatchQueue.global().async { self.startDaemonIfNeeded() }
        }
    }

    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 2) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc func zoomReset(_ sender: Any?) { webView.pageZoom = 1 }
    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(webView.url?.scheme == "http" ? webView.url! : baseURL) }
    @objc func openLogs(_ sender: Any?) { NSWorkspace.shared.open(URL(fileURLWithPath: "\(NSHomeDirectory())/Library/Logs/BotPlatform")) }
    @objc func toggleKeep(_ sender: NSMenuItem) {
        let on = !UserDefaults.standard.bool(forKey: keepRunningKey)
        UserDefaults.standard.set(on, forKey: keepRunningKey)
        sender.state = on ? .on : .off
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Bot Platform", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        keepItem = NSMenuItem(title: "退出后保持后台运行（定时任务需要）", action: #selector(toggleKeep(_:)), keyEquivalent: "")
        keepItem.target = self
        keepItem.state = UserDefaults.standard.bool(forKey: keepRunningKey) ? .on : .off
        appMenu.addItem(keepItem)
        let logs = NSMenuItem(title: "打开日志文件夹", action: #selector(openLogs(_:)), keyEquivalent: "")
        logs.target = self
        appMenu.addItem(logs)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Bot Platform", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Bot Platform", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "显示")
        for (title, sel, key) in [("重新载入", #selector(reload(_:)), "r"), ("放大", #selector(zoomIn(_:)), "="), ("缩小", #selector(zoomOut(_:)), "-"), ("实际大小", #selector(zoomReset(_:)), "0"), ("在浏览器中打开", #selector(openInBrowser(_:)), "")] {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            item.target = self
            view.addItem(item)
        }
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "窗口")
        win.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        main.addItem(windowItem)
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }

    // ---------- app lifecycle ----------
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        if !UserDefaults.standard.bool(forKey: keepRunningKey) { stopDaemon() }
    }

    // ---------- page bridge ----------
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "notify" {
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "Bot Platform"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            let tag = (body["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: tag, content: content, trigger: nil))
        } else if message.name == "theme", let dark = body["dark"] as? Bool {
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.backgroundColor = dark ? NSColor(calibratedWhite: 0.07, alpha: 1) : NSColor(calibratedWhite: 0.97, alpha: 1)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(NSApp.isActive && window.isKeyWindow ? [] : [.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        completionHandler()
    }

    // ---------- navigation, links and downloads ----------
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, url.host != nil, url.host != baseURL.host || url.port != baseURL.port {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    var downloadTargets: [ObjectIdentifier: URL] = [:]
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        var target = dir.appendingPathComponent(name)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = dir.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        downloadTargets[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        alert("下载失败", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // ---------- alert, confirm, prompt and file pickers ----------
    func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
