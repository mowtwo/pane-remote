import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export async function installMenuBar({ appDir, node, configPath, open = true }) {
  if (process.platform !== 'darwin') throw new Error('The menu bar app requires macOS.')
  configPath = path.resolve(configPath)
  const destination = path.join(os.homedir(), 'Applications', 'Pane Remote.app')
  const marker = 'dev.pane-remote.menubar'
  if (fs.existsSync(destination)) {
    const plist = fs.readFileSync(path.join(destination, 'Contents/Info.plist'), 'utf8')
    if (!plist.includes(`<string>${marker}</string>`)) throw new Error(`Refusing to replace unrelated app: ${destination}`)
  }
  const run = (command, args, timeout = 120000) => {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout })
    if (r.status !== 0) throw new Error(r.error?.message || r.stderr || `${command} failed`)
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-menubar-'))
  const bundle = path.join(temp, 'Pane Remote.app')
  const contents = path.join(bundle, 'Contents')
  try {
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
    fs.mkdirSync(path.join(contents, 'Resources'))
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`, '-module-cache-path', path.join(temp, 'ModuleCache'), '-O', '-framework', 'AppKit',
      path.join(appDir, 'macos/MenuBar.swift'), path.join(appDir, 'macos/main.swift'), '-o', path.join(contents, 'MacOS/PaneRemote')])
    fs.writeFileSync(path.join(contents, 'Resources/settings.json'), JSON.stringify({ node, cli: path.join(appDir, 'lib/cli.mjs'), configPath }), { mode: 0o600 })
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${marker}</string>
<key>CFBundleName</key><string>Pane Remote</string>
<key>CFBundleExecutable</key><string>PaneRemote</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
</dict></plist>`)
    // Generate the app icon with the same native drawing used by the menu item.
    run(path.join(contents, 'MacOS/PaneRemote'), ['--icon', path.join(contents, 'Resources/AppIcon.png')])
    const iconset = path.join(temp, 'AppIcon.iconset')
    fs.mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(contents, 'Resources/AppIcon.png'),
          '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)])
      }
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources/AppIcon.icns')])
    fs.unlinkSync(path.join(contents, 'Resources/AppIcon.png'))
    run('/usr/bin/codesign', ['--force', '--sign', '-', bundle])
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    // Stage on the destination volume; rename never leaves a partial app installed.
    const staged = destination + `.new-${process.pid}`
    const backup = destination + `.old-${process.pid}`
    fs.cpSync(bundle, staged, { recursive: true })
    let backedUp = false
    try {
      if (fs.existsSync(destination)) { fs.renameSync(destination, backup); backedUp = true }
      fs.renameSync(staged, destination)
    } catch (error) {
      if (backedUp) fs.renameSync(backup, destination)
      throw error
    } finally { fs.rmSync(staged, { recursive: true, force: true }) }
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true })
    if (open) run('/usr/bin/open', [destination])
    console.log(destination)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
