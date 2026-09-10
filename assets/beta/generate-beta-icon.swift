// Beta icon generator — square artwork (the system applies the dock mask), colors sampled
// pixel-exact from the installed Xcode 26 icon.
//
// Design: full-bleed square. Vertical cyan-to-royal gradient (#0FC3FD -> #186FFA at
// x=300) measured within a few units of Xcode's own stops; a clean 5x5 grid like
// Xcode 26; two guide circles and a squircle inset guide like the classic Xcode Beta;
// faint cardinal axes and diagonals; the Synara mark solid and unshadowed; a white
// SF Pro BETA pill bottom-right with a soft lift shadow.
//
// Usage: swift assets/beta/generate-beta-icon.swift   (from the repo root)
// Outputs the two square masters; derive the rest with sips:
//   beta-macos-legacy-1024.png, beta-universal-1024.png   <- copy of beta-macos-1024.png
//   beta-web-apple-touch-180.png                          <- sips -z 180 180
//   beta-web-favicon-16x16.png / -32x32.png               <- sips -z 16 16 / -z 32 32
//   beta-windows.ico (256) / beta-web-favicon.ico (48)    <- sips -s format ico
import AppKit
import CoreGraphics
import Foundation

let D: CGFloat = 1024
let SS: CGFloat = 2
let PX = Int(D * SS)

struct Palette {
  let top: UInt32
  let upperMid: UInt32
  let lowerMid: UInt32
  let bottom: UInt32
  let mark: UInt32
}

// Light: exact Xcode 26 stop colors.
let light = Palette(top: 0x0FC3FD, upperMid: 0x12A4FA, lowerMid: 0x1683FA, bottom: 0x186FFA, mark: 0x000000)
// Dark appearance: deeper sibling of the same ramp.
let dark = Palette(top: 0x1470D0, upperMid: 0x1062C2, lowerMid: 0x0D53B4, bottom: 0x0A47A6, mark: 0xFFFFFF)

func cg(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

let markPaths: [String] = [
  "M2.65188 2.1899C-0.630695 5.47248 -0.995426 113.797 2.28715 121.821C3.74607 125.104 35.8423 149.906 74.5038 176.531C148.179 227.958 159.121 237.806 170.428 260.054L177.358 273.914L194.135 252.76C203.254 241.088 212.372 228.323 214.196 224.311C228.055 197.685 220.396 158.659 196.324 132.763C181.735 117.08 23.0768 4.37828 11.4054 1.09571C8.12283 0.366249 4.1108 0.73098 2.65188 2.1899Z",
  "M467.348 1.45943C470.631 4.74201 470.995 113.067 467.713 121.091C466.254 124.374 434.158 149.175 395.496 175.801C321.821 227.228 310.879 237.075 299.572 259.324L292.642 273.184L275.865 252.029C266.746 240.358 257.628 227.592 255.804 223.58C241.945 196.955 249.604 157.929 273.676 132.033C288.265 116.35 446.923 3.64782 458.595 0.365241C461.877 -0.36422 465.889 0.000510871 467.348 1.45943Z",
  "M217.479 291.602C187.396 324.802 187 326.002 187 420.002V494.002C187 499.525 191.477 504.002 197 504.002H234.5H272C277.523 504.002 282 499.525 282 494.002V418.002C282 351.202 280.812 329.602 276.458 322.002C269.729 310.002 239.25 274.002 236.083 274.002C234.5 274.002 226.187 282.002 217.479 291.602Z",
]

func parsePath(_ d: String) -> CGPath {
  let path = CGMutablePath()
  var nums: [CGFloat] = []
  var cmds: [(Character, [CGFloat])] = []
  var current = ""
  func flush() {
    if current.isEmpty { return }
    cmds.append((current.first!, nums))
    current = ""; nums = []
  }
  var token = ""
  func flushToken() {
    if !token.isEmpty { nums.append(CGFloat(Double(token) ?? 0)); token = "" }
  }
  for ch in d {
    if ch.isLetter { flushToken(); flush(); current = String(ch) }
    else if ch == "," || ch == " " { flushToken() }
    else { token.append(ch) }
  }
  flushToken(); flush()

  var last = CGPoint.zero
  var start = CGPoint.zero
  for (cmd, a) in cmds {
    switch cmd {
    case "M": last = CGPoint(x: a[0], y: a[1]); start = last; path.move(to: last)
    case "L": last = CGPoint(x: a[0], y: a[1]); path.addLine(to: last)
    case "H": last = CGPoint(x: a[0], y: last.y); path.addLine(to: last)
    case "V": last = CGPoint(x: last.x, y: a[0]); path.addLine(to: last)
    case "C":
      let c1 = CGPoint(x: a[0], y: a[1]); let c2 = CGPoint(x: a[2], y: a[3]); let to = CGPoint(x: a[4], y: a[5])
      path.addCurve(to: to, control1: c1, control2: c2); last = to
    case "Z": path.closeSubpath(); last = start
    default: break
    }
  }
  return path
}

let markPath: CGPath = {
  let p = CGMutablePath()
  for d in markPaths { p.addPath(parsePath(d)) }
  return p
}()

func addMark(to ctx: CGContext) {
  var t = CGAffineTransform(translationX: 274, y: 280)
  if let moved = markPath.copy(using: &t) { ctx.addPath(moved) }
}

func drawIcon(_ p: Palette, name: String) {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  guard let ctx = CGContext(data: nil, width: PX, height: PX, bitsPerComponent: 8, bytesPerRow: 0,
                            space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { print("no ctx"); return }
  ctx.saveGState()
  ctx.translateBy(x: 0, y: CGFloat(PX))
  ctx.scaleBy(x: 1, y: -1)
  ctx.scaleBy(x: SS, y: SS)
  ctx.setShouldAntialias(true)

  // Full-bleed square gradient (the dock supplies the mask).
  let stops = [cg(p.top), cg(p.upperMid), cg(p.lowerMid), cg(p.bottom)] as CFArray
  if let g = CGGradient(colorsSpace: cs, colors: stops, locations: [0, 0.35, 0.7, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: D), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }

  // Blueprint shell: clean 5x5 grid (Xcode 26), guide circles and squircle inset (classic beta)
  ctx.setLineWidth(2.5)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.14))
  for step in 1...4 {
    let v = CGFloat(step) * D / 5
    ctx.move(to: CGPoint(x: v, y: 0)); ctx.addLine(to: CGPoint(x: v, y: D))
    ctx.move(to: CGPoint(x: 0, y: v)); ctx.addLine(to: CGPoint(x: D, y: v))
  }
  ctx.strokePath()

  // Faint cardinal axes
  ctx.setLineWidth(2)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.07))
  ctx.move(to: CGPoint(x: 512, y: 0)); ctx.addLine(to: CGPoint(x: 512, y: D))
  ctx.move(to: CGPoint(x: 0, y: 512)); ctx.addLine(to: CGPoint(x: D, y: 512))
  ctx.strokePath()

  // Diagonals
  ctx.setLineWidth(1.6)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.06))
  ctx.move(to: CGPoint(x: 0, y: 0)); ctx.addLine(to: CGPoint(x: D, y: D))
  ctx.move(to: CGPoint(x: 0, y: D)); ctx.addLine(to: CGPoint(x: D, y: 0))
  ctx.strokePath()

  // Concentric guide circles
  ctx.setLineWidth(2.6)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.18))
  ctx.strokeEllipse(in: CGRect(x: 512 - 344, y: 512 - 344, width: 688, height: 688))
  ctx.setLineWidth(2)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.08))
  ctx.strokeEllipse(in: CGRect(x: 512 - 470, y: 512 - 470, width: 940, height: 940))

  // Squircle inset guide
  ctx.setLineWidth(2.4)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.14))
  ctx.addPath(CGPath(roundedRect: CGRect(x: 72, y: 72, width: D - 144, height: D - 144), cornerWidth: 160, cornerHeight: 160, transform: nil))
  ctx.strokePath()

  // Solid mark (flat, no baked lighting)
  ctx.setFillColor(cg(p.mark))
  addMark(to: ctx)
  ctx.fillPath()

  ctx.restoreGState()

  // BETA pill: inside the dock mask, bottom right
  let pillRect = CGRect(x: 1010, y: 128, width: 860, height: 300)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: cg(0x03183A, 0.22))
  ctx.addPath(CGPath(roundedRect: pillRect, cornerWidth: 150, cornerHeight: 150, transform: nil))
  ctx.setFillColor(cg(0xFFFFFF))
  ctx.fillPath()
  ctx.restoreGState()

  let font = NSFont.systemFont(ofSize: 200, weight: .bold)
  let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor(srgbRed: 0x1A / 255.0, green: 0x73 / 255.0, blue: 0xE8 / 255.0, alpha: 1),
    .kern: 20,
  ]
  let text = NSAttributedString(string: "BETA", attributes: attrs)
  let size = text.size()
  let rect = CGRect(x: pillRect.minX + (pillRect.width - size.width) / 2 + 6, y: pillRect.minY + (pillRect.height - size.height) / 2, width: size.width, height: size.height)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  text.draw(in: rect)
  NSGraphicsContext.restoreGraphicsState()

  guard let image = ctx.makeImage() else { print("no image"); return }
  let rep = NSBitmapImageRep(cgImage: image)
  let scaled = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(D), pixelsHigh: Int(D),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bitmapFormat: [], bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: scaled)
  let source = NSImage(size: NSSize(width: D, height: D))
  source.addRepresentation(rep)
  source.draw(in: NSRect(x: 0, y: 0, width: D, height: D), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  let png = scaled.representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/\(name).png"))
  print("saved \(name).png")
}

drawIcon(light, name: "assets/beta/beta-macos-1024")
drawIcon(dark, name: "assets/beta/beta-macos-legacy-dark-1024")
