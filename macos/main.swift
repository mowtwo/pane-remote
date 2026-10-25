import AppKit

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--icon" {
    let icon = terminalIcon(size: 1024, appIcon: true)
    let rep = NSBitmapImageRep(data: icon.tiffRepresentation!)!
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
} else {
    let app = NSApplication.shared
    let delegate = MenuApp(); app.delegate = delegate
    app.setActivationPolicy(.accessory); app.run()
}
