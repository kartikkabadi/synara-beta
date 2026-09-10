// Beta icon generator — native CoreGraphics, supersampled 2x, top-left design space at 1024.
//
// Design: Xcode-style engineering blueprint. Diagonal cyan->cobalt gradient with an
// upper light pool and a lower-right vignette; fine grid, guide circles, tick ring and
// inset contour; the mark carries a white wireframe registration edge, a concentric
// plan ring, a subtle vertical gradient, a top rim light and a soft cast shadow; the
// BETA pill sits bottom-right over the corner with layered elevation and SF Pro type.
//
// Usage: swift assets/beta/generate-beta-icon.swift   (from the repo root)
// Outputs the two 1024 masters; derive the rest with sharp/sips:
//   beta-macos-legacy-1024.png, beta-universal-1024.png   <- copy of beta-macos-1024.png
//   beta-web-apple-touch-180.png                          <- sips -z 180 180
//   beta-web-favicon-16x16.png / -32x32.png               <- sips -z 16 16 / -z 32 32
//   beta-windows.ico (256) / beta-web-favicon.ico (48)    <- sips -s format ico
import AppKit
import CoreGraphics
import Foundation

let D: CGFloat = 1024 // design space
let SS: CGFloat = 2   // supersample
let PX = Int(D * SS)

struct Palette {
  let top: UInt32
  let mid: UInt32
  let bottom: UInt32
  let mark: UInt32
  let wire: CGFloat
  let glow: CGFloat
}

let light = Palette(top: 0x16ACFB, mid: 0x0B63D8, bottom: 0x05286E, mark: 0x000000, wire: 0.50, glow: 0.10)
let dark = Palette(top: 0x2273E0, mid: 0x0E4AA8, bottom: 0x042058, mark: 0xFFFFFF, wire: 0.42, glow: 0.06)

func cg(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

let markPaths: [String] = [
  "M2.65188 2.1899C-0.630695 5.47248 -0.995426 113.797 2.28715 121.821C3.74607 125.104 35.8423 149.906 74.5038 176.531C148.179 227.958 159.121 237.806 170.428 260.054L177.358 273.914L194.135 252.76C203.254 241.088 212.372 228.323 214.196 224.311C228.055 197.685 220.396 158.659 196.324 132.763C181.735 117.08 23.0768 4.37828 11.4054 1.09571C8.12283 0.366249 4.1108 0.73098 2.65188 2.1899Z",
  "M467.348 1.45943C470.631 4.74201 470.995 113.067 467.713 121.091C466.254 124.374 434.158 149.175 395.496 175.801C321.821 227.228 310.879 237.075 299.572 259.324L292.642 273.184L275.865 252.029C266.746 240.358 257.628 227.592 255.804 223.58C241.945 196.955 249.604 157.929 273.676 132.033C288.265 116.35 446.923 3.64782 458.595 0.365241C461.877 -0.36422 465.889 0.000510871 467.348 1.45943Z",
  "M217.479 291.602C187.396 324.802 187 326.002 187 420.002V494.002C187 499.525 191.477 504.002 197 504.002H234.5H272C277.523 504.002 282 499.525 282 494.002V418.002C282 351.202 280.812 329.602 276.458 322.002C269.729 310.002 239.25 274.002 236.083 274.002C234.5 274.002 226.187 282.002 217.479 291.602Z",
]

// Minimal SVG path parser: M, L, H, V, C, Z (absolute).
func parsePath(_ d: String) -> CGPath {
  let path = CGMutablePath()
  var nums: [CGFloat] = []
  var cmds: [(Character, [CGFloat])] = []
  var current = ""
  func flush() {
    if current.isEmpty { return }
    let cmd = current.first!
    cmds.append((cmd, nums))
    current = ""
    nums = []
  }
  var i = d.startIndex
  var token = ""
  func flushToken() {
    if !token.isEmpty { nums.append(CGFloat(Double(token) ?? 0)); token = "" }
  }
  while i < d.endIndex {
    let ch = d[i]
    if ch.isLetter {
      flushToken()
      flush()
      current = String(ch)
    } else if ch == "," || ch == " " {
      flushToken()
    } else {
      token.append(ch)
    }
    i = d.index(after: i)
  }
  flushToken()
  flush()

  var last = CGPoint.zero
  var start = CGPoint.zero
  for (cmd, a) in cmds {
    switch cmd {
    case "M":
      last = CGPoint(x: a[0], y: a[1]); start = last; path.move(to: last)
    case "L":
      last = CGPoint(x: a[0], y: a[1]); path.addLine(to: last)
    case "H":
      last = CGPoint(x: a[0], y: last.y); path.addLine(to: last)
    case "V":
      last = CGPoint(x: last.x, y: a[0]); path.addLine(to: last)
    case "C":
      let c1 = CGPoint(x: a[0], y: a[1]); let c2 = CGPoint(x: a[2], y: a[3]); let to = CGPoint(x: a[4], y: a[5])
      path.addCurve(to: to, control1: c1, control2: c2); last = to
    case "Z":
      path.closeSubpath(); last = start
    default:
      break
    }
  }
  return path
}

var translateMarkTransform = CGAffineTransform(translationX: 274, y: 280)
let markPath: CGPath = {
  let p = CGMutablePath()
  for d in markPaths { p.addPath(parsePath(d)) }
  return p
}()

func addMark(to ctx: CGContext, translate: CGPoint) {
  var t = CGAffineTransform(translationX: translate.x, y: translate.y)
  if let moved = markPath.copy(using: &t) { ctx.addPath(moved) }
}

func drawIcon(_ p: Palette, name: String) {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  guard let ctx = CGContext(data: nil, width: PX, height: PX, bitsPerComponent: 8, bytesPerRow: 0,
                            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    print("no ctx"); return
  }
  // top-left design space at 1024
  ctx.saveGState()
  ctx.translateBy(x: 0, y: CGFloat(PX))
  ctx.scaleBy(x: 1, y: -1)
  ctx.scaleBy(x: SS, y: SS)
  ctx.setAllowsAntialiasing(true)
  ctx.setShouldAntialias(true)

  // Tile clip
  let tile = CGPath(roundedRect: CGRect(x: 0, y: 0, width: D, height: D), cornerWidth: 232, cornerHeight: 232, transform: nil)
  ctx.saveGState()
  ctx.addPath(tile)
  ctx.clip()

  // Diagonal gradient (upper-left cyan -> lower-right cobalt)
  let colors = [cg(p.top), cg(p.mid), cg(p.bottom)] as CFArray
  let locs: [CGFloat] = [0, 0.55, 1]
  if let g = CGGradient(colorsSpace: cs, colors: colors, locations: locs) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 60, y: 40), end: CGPoint(x: 900, y: 980), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }

  // Soft light from upper-left
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xFFFFFF, p.glow), cg(0xFFFFFF, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 330, y: 210), startRadius: 0, endCenter: CGPoint(x: 330, y: 210), endRadius: 1150, options: [])
  }

  // Lower-right vignette
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0x021A44, 0.16), cg(0x021A44, 0)] as CFArray, locations: [0, 1]) {
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 880, y: 920), startRadius: 0, endCenter: CGPoint(x: 880, y: 920), endRadius: 760, options: [])
  }

  // Blueprint grid
  ctx.setLineWidth(1.6)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.045))
  var x: CGFloat = 128
  while x < D { ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: D)); x += 128 }
  var y: CGFloat = 128
  while y < D { ctx.move(to: CGPoint(x: 0, y: y)); ctx.addLine(to: CGPoint(x: D, y: y)); y += 128 }
  ctx.strokePath()

  // Diagonals
  ctx.setStrokeColor(cg(0xFFFFFF, 0.05))
  ctx.setLineWidth(1.6)
  ctx.move(to: CGPoint(x: 0, y: 0)); ctx.addLine(to: CGPoint(x: D, y: D))
  ctx.move(to: CGPoint(x: 0, y: D)); ctx.addLine(to: CGPoint(x: D, y: 0))
  ctx.strokePath()

  // Concentric guide circles + tick ring
  ctx.setStrokeColor(cg(0xFFFFFF, 0.13))
  ctx.setLineWidth(3.0)
  ctx.strokeEllipse(in: CGRect(x: 512 - 344, y: 512 - 344, width: 688, height: 688))
  ctx.setStrokeColor(cg(0xFFFFFF, 0.06))
  ctx.strokeEllipse(in: CGRect(x: 512 - 472, y: 512 - 472, width: 944, height: 944))
  ctx.setLineWidth(3.2)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.15))
  let tickCount = 72
  for t in 0..<tickCount {
    if t % 6 == 0 { continue }
    let a = CGFloat(t) / CGFloat(tickCount) * 2 * .pi
    let r0: CGFloat = 404
    let r1: CGFloat = 392
    ctx.move(to: CGPoint(x: 512 + cos(a) * r0, y: 512 + sin(a) * r0))
    ctx.addLine(to: CGPoint(x: 512 + cos(a) * r1, y: 512 + sin(a) * r1))
  }
  ctx.strokePath()

  // Inset contour guide
  let inset = CGPath(roundedRect: CGRect(x: 64, y: 64, width: D - 128, height: D - 128), cornerWidth: 170, cornerHeight: 170, transform: nil)
  ctx.addPath(inset)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.22))
  ctx.setLineWidth(3.6)
  ctx.strokePath()

  // Blueprint registration: white wireframe edge hugging the mark + concentric plan ring
  ctx.saveGState()
  ctx.setStrokeColor(cg(0xFFFFFF, p.wire))
  ctx.setLineWidth(7)
  ctx.setLineJoin(.round)
  addMark(to: ctx, translate: CGPoint(x: 274, y: 280))
  ctx.strokePath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.translateBy(x: 510, y: 532)
  ctx.scaleBy(x: 1.16, y: 1.16)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.20))
  ctx.setLineWidth(2.2)
  ctx.setLineJoin(.round)
  addMark(to: ctx, translate: CGPoint(x: 274, y: 280))
  ctx.strokePath()
  ctx.restoreGState()

  // Solid mark with soft cast shadow + subtle vertical volume
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -26), blur: 56, color: cg(0x000000, 0.45))
  addMark(to: ctx, translate: CGPoint(x: 274, y: 280))
  ctx.clip()
  let markTop: UInt32 = p.mark == 0 ? 0x20242D : 0xFFFFFF
  let markBottom: UInt32 = p.mark == 0 ? 0x000000 : 0xD9E4F2
  if let g = CGGradient(colorsSpace: cs, colors: [cg(markTop), cg(markBottom)] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 280), end: CGPoint(x: 0, y: 785), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  }
  ctx.restoreGState()
  // Top rim light: light catches the upper edges of the glyph
  ctx.saveGState()
  addMark(to: ctx, translate: CGPoint(x: 274, y: 280))
  ctx.clip()
  ctx.clip(to: CGRect(x: 180, y: 270, width: 700, height: 175))
  ctx.addPath(markPath.copy(using: &translateMarkTransform)!)
  ctx.setStrokeColor(cg(0xFFFFFF, 0.28))
  ctx.setLineWidth(3.2)
  ctx.setLineJoin(.round)
  ctx.strokePath()
  ctx.restoreGState()

  ctx.restoreGState() // end tile clip

  ctx.restoreGState() // back to identity (device) space

  // Pill (device space, bottom-left origin)
  let pillRect = CGRect(x: 1180, y: 92, width: 816, height: 304)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -40), blur: 92, color: cg(0x03183A, 0.28))
  ctx.addPath(CGPath(roundedRect: pillRect, cornerWidth: 150, cornerHeight: 150, transform: nil))
  ctx.setFillColor(cg(0xFFFFFF))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 30, color: cg(0x03183A, 0.24))
  ctx.addPath(CGPath(roundedRect: pillRect, cornerWidth: 150, cornerHeight: 150, transform: nil))
  ctx.setFillColor(cg(0xFFFFFF))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(CGPath(roundedRect: pillRect, cornerWidth: 150, cornerHeight: 150, transform: nil))
  ctx.clip()
  if let g = CGGradient(colorsSpace: cs, colors: [cg(0xFFFFFF), cg(0xE7EFF9)] as CFArray, locations: [0, 1]) {
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: pillRect.maxY), end: CGPoint(x: 0, y: pillRect.minY), options: [])
  }
  ctx.restoreGState()

  // BETA (SF Pro)
  let font = NSFont.systemFont(ofSize: 160, weight: .bold)
  let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor(srgbRed: 0x0A / 255.0, green: 0x5B / 255.0, blue: 0xD6 / 255.0, alpha: 1),
    .kern: 18,
  ]
  let text = NSAttributedString(string: "BETA", attributes: attrs)
  let size = text.size()
  let rect = CGRect(x: 1180 + (816 - size.width) / 2 + 8, y: 92 + (304 - size.height) / 2, width: size.width, height: size.height)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  text.draw(in: rect)
  NSGraphicsContext.restoreGraphicsState()

  // Downsample 2048 -> 1024 for crisp edges, then save.
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
  let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/\(name).png")
  try! png.write(to: url)
  print("saved \(url.lastPathComponent)")
}

let fm = FileManager.default
_ = try? fm.createDirectory(atPath: fm.currentDirectoryPath + "/v6", withIntermediateDirectories: true)
// run from the repo root; writes into assets/beta/
drawIcon(light, name: "assets/beta/beta-macos-1024")
drawIcon(dark, name: "assets/beta/beta-macos-legacy-dark-1024")
