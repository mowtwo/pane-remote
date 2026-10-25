import AppKit

struct Settings: Decodable { let node: String; let cli: String; let configPath: String }
struct ServiceStatus: Decodable {
    let configured: Bool; let loaded: Bool; let response: Int
    let backend: String; let mode: String; let lang: String
    let url: String?; let configPath: String; let logPath: String
}

// Vector terminal glyph remains legible as an 18pt template and a Finder icon.
func terminalIcon(size: CGFloat, appIcon: Bool = false) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    if appIcon {
        NSColor(calibratedRed: 0.18, green: 0.30, blue: 0.64, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: size * 0.22, yRadius: size * 0.22).fill()
    }
    (appIcon ? NSColor.white : NSColor.black).setStroke()
    let inset = size * (appIcon ? 0.18 : 0.07)
    let frame = NSBezierPath(roundedRect: NSRect(x: inset, y: inset + size * 0.06, width: size - 2 * inset, height: size - 2 * inset - size * 0.12), xRadius: size * 0.08, yRadius: size * 0.08)
    frame.lineWidth = size * 0.065; frame.stroke()
    let prompt = NSBezierPath()
    prompt.move(to: NSPoint(x: size * 0.30, y: size * 0.61))
    prompt.line(to: NSPoint(x: size * 0.41, y: size * 0.50))
    prompt.line(to: NSPoint(x: size * 0.30, y: size * 0.39))
    prompt.move(to: NSPoint(x: size * 0.49, y: size * 0.39))
    prompt.line(to: NSPoint(x: size * 0.67, y: size * 0.39))
    prompt.lineWidth = size * 0.065; prompt.lineCapStyle = .round; prompt.lineJoinStyle = .round; prompt.stroke()
    image.unlockFocus(); image.isTemplate = !appIcon
    return image
}

final class MenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    var settings: Settings!
    var status: ServiceStatus?
    var pageURL: URL?
    var busy = false
    var refreshing = false
    var pendingURLRefresh = false
    var generation = 0
    var lastError: String?
    var timer: Timer?
    var zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    func tr(_ cn: String, _ en: String) -> String { zh ? cn : en }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if NSRunningApplication.runningApplications(withBundleIdentifier: "dev.pane-remote.menubar").contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil); return
        }
        do {
            settings = try JSONDecoder().decode(Settings.self, from: Data(contentsOf: Bundle.main.url(forResource: "settings", withExtension: "json")!))
        } catch { showError(error.localizedDescription); NSApp.terminate(nil); return }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = terminalIcon(size: 18)
        item.button?.imagePosition = .imageLeft
        rebuild()
        refresh(includeURL: true)
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        item?.isVisible = true
        if settings != nil { refresh(includeURL: true) }
        return true
    }
    func menuWillOpen(_ menu: NSMenu) { refresh(includeURL: true) }
    func row(_ title: String, _ action: Selector? = nil, enabled: Bool = true) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: action, keyEquivalent: "")
        row.target = self; row.isEnabled = enabled && action != nil; return row
    }
    func rebuild() {
        let menu = NSMenu(); menu.autoenablesItems = false; menu.delegate = self
        let healthy = status?.loaded == true && status?.response == 200
        let label: String
        if busy { label = tr("正在处理…", "Working…") }
        else if lastError != nil { label = tr("检查失败", "Check failed") }
        else if status?.configured == false { label = tr("尚未配置 · 请先运行 init", "Not configured · run init first") }
        else if healthy { label = tr("服务运行中", "Service running") }
        else if status?.loaded == true { label = tr("服务已加载 · 暂无正常响应", "Service loaded · not responding") }
        else if status?.response == 200 { label = tr("外部服务正在运行", "Externally managed service running") }
        else if status != nil { label = tr("服务已停止", "Service stopped") }
        else { label = tr("正在检查…", "Checking…") }
        item.button?.title = healthy ? "" : " ·"
        item.button?.toolTip = "Pane Remote — \(label)"
        menu.addItem(row("Pane Remote · \(label)"))
        if lastError != nil { menu.addItem(row(tr("查看错误…", "Show error…"), #selector(errorDetails))) }
        menu.addItem(.separator())
        menu.addItem(row(tr("打开页面", "Open page"), #selector(openPage), enabled: pageURL != nil && !busy))
        menu.addItem(row(tr("复制页面地址", "Copy page URL"), #selector(copyURL), enabled: pageURL != nil && !busy))
        if pageURL == nil { menu.addItem(row(tr("未找到 Tailscale Serve 地址", "No Tailscale Serve URL found"))) }
        menu.addItem(.separator())
        let control = !busy && status?.configured == true && status?.mode == "local" && lastError == nil
        menu.addItem(row(tr("启动服务", "Start service"), #selector(start), enabled: control && status?.loaded == false && status?.response != 200))
        menu.addItem(row(tr("停止服务", "Stop service"), #selector(stop), enabled: control && status?.loaded == true))
        menu.addItem(row(tr("重启服务", "Restart service"), #selector(restart), enabled: control && status?.loaded == true))
        let backend = row(tr("终端来源", "Terminal source") + " · " + (status?.backend == "herdr" ? "Herdr" : "WezTerm"), enabled: control)
        backend.isEnabled = control
        let sources = NSMenu(); sources.autoenablesItems = false
        for name in ["Herdr", "WezTerm"] {
            let source = row(name, #selector(selectBackend(_:)), enabled: control)
            source.representedObject = name.lowercased()
            source.state = status?.backend == name.lowercased() ? .on : .off
            sources.addItem(source)
        }
        backend.submenu = sources; menu.addItem(backend)
        menu.addItem(row(tr("切换来源会重启正在运行的服务", "Switching restarts a running service")))
        menu.addItem(.separator())
        menu.addItem(row(tr("打开配置文件", "Open configuration"), #selector(openConfig)))
        menu.addItem(row(tr("查看日志", "View logs"), #selector(openLogs)))
        menu.addItem(row(tr("刷新状态", "Refresh status"), #selector(manualRefresh), enabled: !busy))
        menu.addItem(.separator())
        menu.addItem(row(tr("隐藏菜单栏图标", "Hide menu bar icon"), #selector(hideIcon)))
        item.menu = menu
    }
    // No shell interpolation; use the Node selected during installation, including
    // for Finder launches whose PATH does not contain Homebrew or a version manager.
    func command(_ arguments: [String], completion: @escaping (Result<Data, Error>) -> Void) {
        let settings = self.settings!
        DispatchQueue.global(qos: .utility).async {
            let process = Process(); let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: settings.node)
            process.arguments = [settings.cli] + arguments
            var env = ProcessInfo.processInfo.environment
            env["PANE_REMOTE_CONFIG"] = settings.configPath
            env["PATH"] = URL(fileURLWithPath: settings.node).deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            process.environment = env; process.standardOutput = pipe; process.standardError = pipe
            do {
                try process.run()
                let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: timeout)
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit(); timeout.cancel()
                if process.terminationStatus != 0 {
                    let message = String(data: data, encoding: .utf8) ?? "Command failed"
                    throw NSError(domain: "PaneRemote", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message.replacingOccurrences(of: "\u{001B}\\[[0-9;]*m", with: "", options: .regularExpression)])
                }
                DispatchQueue.main.async { completion(.success(data)) }
            } catch { DispatchQueue.main.async { completion(.failure(error)) } }
        }
    }
    func refresh(includeURL: Bool = false) {
        // A menu-open refresh must not be lost behind a passive timer check.
        if includeURL { pendingURLRefresh = true }
        guard !busy && !refreshing else { return }
        let fetchURL = pendingURLRefresh
        pendingURLRefresh = false
        refreshing = true
        let requestGeneration = generation
        command(["status", "--json"] + (fetchURL ? ["--url"] : [])) { result in
            self.refreshing = false
            guard requestGeneration == self.generation else { self.refresh(includeURL: true); return }
            do {
                self.status = try JSONDecoder().decode(ServiceStatus.self, from: result.get())
                self.zh = self.status?.lang == "zh"
                if fetchURL { self.pageURL = self.status?.url.flatMap { URL(string: $0) } }
                self.lastError = nil
            } catch { self.lastError = error.localizedDescription }
            self.rebuild()
            if self.pendingURLRefresh { self.refresh() }
        }
    }
    func perform(_ args: [String]) {
        guard !busy else { return }; busy = true; generation += 1; rebuild()
        command(args) { result in
            self.busy = false
            if case .failure(let error) = result { self.showError(error.localizedDescription) }
            self.refresh(includeURL: true)
        }
    }
    func showError(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = "Pane Remote"; alert.informativeText = String(message.prefix(2500)); alert.alertStyle = .warning; alert.runModal()
    }
    @objc func errorDetails() { showError(lastError ?? "") }
    @objc func start() { perform(["start"]) }
    @objc func stop() { perform(["stop"]) }
    @objc func restart() { perform(["restart"]) }
    @objc func selectBackend(_ sender: NSMenuItem) { if let name = sender.representedObject as? String { perform(["terminal", name]) } }
    @objc func manualRefresh() { refresh(includeURL: true) }
    @objc func openPage() { if let url = pageURL { NSWorkspace.shared.open(url) } }
    @objc func copyURL() { if let url = pageURL { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string) } }
    @objc func openConfig() { NSWorkspace.shared.open(URL(fileURLWithPath: settings.configPath)) }
    @objc func openLogs() { if let log = status?.logPath { NSWorkspace.shared.open(URL(fileURLWithPath: log)) } }
    @objc func hideIcon() { item.isVisible = false }
}
