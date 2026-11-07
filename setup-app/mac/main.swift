// Codex Mods Setup, the Mac app (setup-app/README.md): one window that shows the setup page. It starts the page's server from the
// framework tree it carries (Resources/codex-mods/setup-app/server.mjs) with the Node.js this Mac has, loads the address the server
// prints, and ends the server when it quits. Links that leave 127.0.0.1 open in the browser. No network of its own, no other files.
import AppKit
import WebKit

final class SetupApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
  private var window: NSWindow!
  private var web: WKWebView!
  private var server: Process?
  private var loaded = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: "setup")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 620), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Codex Mods Setup"
    window.contentView = web
    window.delegate = self
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.mainMenu = menu()
    NSApp.activate(ignoringOtherApps: true)
    start()
  }

  private func menu() -> NSMenu {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let app = NSMenu()
    app.addItem(withTitle: "Quit Codex Mods Setup", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = app
    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    return main
  }

  /// The Node.js to run the setup with: CODEX_MODS_NODE, Homebrew's, the usual install, or what a login shell finds.
  private func node() -> String? {
    let fm = FileManager.default
    var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    if let own = ProcessInfo.processInfo.environment["CODEX_MODS_NODE"] { candidates.insert(own, at: 0) }
    if let found = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) { return found }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v node"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return path.hasPrefix("/") && fm.isExecutableFile(atPath: path) ? path : nil
  }

  private func start() {
    guard let tree = Bundle.main.resourceURL?.appendingPathComponent("codex-mods") else { return problem("The setup app is incomplete", "Its framework files are missing. Download it again.") }
    let script = tree.appendingPathComponent("setup-app/server.mjs").path
    guard FileManager.default.fileExists(atPath: script) else { return problem("The setup app is incomplete", "Its framework files are missing. Download it again.") }
    guard let node = node() else { return problem("Node.js is needed", "Codex Mods builds its copy and runs mods with Node.js 24 or newer. Install it from nodejs.org, then open Codex Mods Setup again.") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [script, "--parent", String(getpid())]
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    var buffer = ""
    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil; return }
      buffer += String(data: data, encoding: .utf8) ?? ""
      guard let line = buffer.split(separator: "\n").first(where: { $0.hasPrefix("READY http://127.0.0.1:") }), let url = URL(string: String(line.dropFirst(6))) else { return }
      handle.readabilityHandler = nil
      DispatchQueue.main.async { self?.loaded = true; self?.web.load(URLRequest(url: url)) }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self else { return }
        if !self.loaded { self.problem("The setup app couldn\u{2019}t start", "Node.js stopped with code \(proc.terminationStatus). Codex Mods needs Node.js 24 or newer.") }
      }
    }
    do { try p.run(); server = p } catch { problem("The setup app couldn\u{2019}t start", error.localizedDescription) }
  }

  private func problem(_ title: String, _ text: String) {
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
    let html = """
    <!doctype html><meta charset="utf-8"><style>:root{color-scheme:light dark}body{margin:0;font:13px -apple-system,sans-serif;padding:40px;}
    h1{font-size:24px;font-weight:600;margin:0 0 8px}p{opacity:.65;line-height:1.45;max-width:560px}</style><h1>\(esc(title))</h1><p>\(esc(text))</p>
    """
    web.loadHTMLString(html, baseURL: nil)
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1") { return decisionHandler(.allow) }
    if url.scheme == "https" { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    if (message.body as? String) == "quit" { NSApp.terminate(nil) }
  }

  func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
  func applicationWillTerminate(_ notification: Notification) { server?.terminate() }
}

let app = NSApplication.shared
let delegate = SetupApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
