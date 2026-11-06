// Draws the app icon: four rounded tiles, one per Bot, on a dark rounded square.
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let shape = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.22, alpha: 1), ending: NSColor(calibratedRed: 0.06, green: 0.06, blue: 0.08, alpha: 1))!.draw(in: shape, angle: -90)
NSColor(calibratedWhite: 1, alpha: 0.08).setStroke()
shape.lineWidth = 6
shape.stroke()
let tile: CGFloat = 210
let gap: CGFloat = 56
let start = (size - tile * 2 - gap) / 2
let colors: [NSColor] = [
    NSColor(calibratedRed: 0.42, green: 0.49, blue: 1.0, alpha: 1),
    NSColor(calibratedRed: 0.18, green: 0.78, blue: 0.62, alpha: 1),
    NSColor(calibratedRed: 1.0, green: 0.62, blue: 0.27, alpha: 1),
    NSColor(calibratedRed: 0.93, green: 0.36, blue: 0.52, alpha: 1),
]
for (i, color) in colors.enumerated() {
    let x = start + CGFloat(i % 2) * (tile + gap)
    let y = start + CGFloat(1 - i / 2) * (tile + gap)
    color.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: tile, height: tile), xRadius: 58, yRadius: 58).fill()
}
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
