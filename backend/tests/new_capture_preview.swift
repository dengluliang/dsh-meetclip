import SwiftUI
import AppKit
import Network

// AsyncImage uses its own loader; serve the reference cover over local HTTP.
final class PreviewCoverServer: @unchecked Sendable {
    let listener: NWListener
    let image: Data
    private let lock = NSLock()
    private var requests = 0

    init() throws {
        let file = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("tests/fixtures/live-preview-cover.png")
        image = try Data(contentsOf: file)
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [self] connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [self] data, _, _, _ in
                let missing = String(data: data ?? Data(), encoding: .utf8)?.contains(" /missing.png ") == true
                let body = missing ? Data() : image
                lock.withLock { requests += 1 }
                let header = "HTTP/1.1 \(missing ? "404 Not Found" : "200 OK")\r\nContent-Type: image/png\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    func start() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: "http://127.0.0.1:\(listener.port!.rawValue)")
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: .main)
        }
    }
    var receivedRequests: Int { lock.withLock { requests } }
}

@MainActor final class DetailVM: ObservableObject {
    @Published var detail: SessionDetail?
    @Published var actionError = ""
    var isActive: Bool { false }
    func load(_ id: String) async {}
}

extension Bundle {
    static let module = Bundle(url: URL(fileURLWithPath:
        ProcessInfo.processInfo.environment["PACKAGE_RESOURCE_BUNDLE_PATH"] ??
        FileManager.default.currentDirectoryPath + "/macos/ZhiBoApp/.build/debug")
        .appendingPathComponent("ZhiBoApp_ZhiBoApp.bundle"))!
}

// Isolated UI fixtures: render the production new-capture views without launching
// the application backend, reading the clipboard, or creating real sessions.
@MainActor final class Backend: ObservableObject {
    static let shared = Backend()
    @Published var deps = DepsStatus(yt_dlp: true, ffmpeg: true, asr: true, asr_runtime: true, ready: true)
    var asrReady: Bool { asr?.ready == true }
    var selectedAsrProvider: String { "local" }
    @Published var asr: AsrStatus? = readyStatus
    @Published var aligner: AsrStatus? = readyStatus
    @Published var diarizeModel: AsrStatus? = readyStatus
    var meetingOptions: MeetingOptions? = readyOptions
    var mode = "ready"
    var coverBaseURL = ""
    let liveStart = Date().timeIntervalSince1970 - 3700
    var creates = 0
    var requests: [(String, [String: Any])] = []
    func downloadDiarizeModel() {}
    func del(_ path: String) async throws {}
    func patch(_ path: String, json: [String: Any]) async throws {}
    func postEmpty(_ path: String) async throws { creates += 1 }
    func get<T: Decodable>(_ path: String) async throws -> T {
        let options = mode == "models" ? MeetingOptions(languages: Self.readyOptions.languages, aligner_ready: false,
            aligner_state: "idle", asr_ready: false, diarize: DiarizeStatus(available: false, package: true,
            model_ready: false, model_state: "idle", reason: "需下载说话人模型")) : Self.readyOptions
        return try decode(options)
    }
    func post<T: Decodable>(_ path: String, json: [String: Any]) async throws -> T {
        requests.append((path, json))
        if mode == "loading" { try await Task.sleep(for: .seconds(10)) }
        if path == "/api/precheck" {
            if mode == "real-live", let file = ProcessInfo.processInfo.environment["MEETCLIP_LIVE_PREVIEW_JSON"] {
                return try JSONDecoder().decode(T.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
            }
            if mode.hasPrefix("same-live") {
                return try decode(PrecheckResult(ok: true, status: "live", room_id: 5146309,
                    title: "特斯拉ROADSTER发布会（回放）", message: "预读完成", thumbnail: sameLiveThumbnail,
                    uploader: "发布会官方", started_at: liveStart, category: "科技"))
            }
            return try decode(PrecheckResult(ok: mode != "failed", status: mode == "failed" ? "not_started" : "live",
                                            room_id: 123, title: "秋季新品发布会", message: "预读完成"))
        }
        if path == "/api/link-videos/preview" {
            if mode.hasPrefix("x-") {
                let failed = mode == "x-login"
                return try decode(LinkPreview(ok: !failed, status: failed ? "login_required" : "ready",
                    url: json["url"] as? String, normalized_url: "https://x.com/i/web/status/123456",
                    platform: "x", extractor: "Twitter", title: failed ? nil : "演示作者 - X 平台新品演示",
                    thumbnail: failed ? nil : coverBaseURL + "/cover.png", uploader: failed ? nil : "演示作者",
                    duration: failed ? nil : 125, estimated_bytes: nil,
                    message: failed ? "请登录 X 后重试" : "预读完成", subtitle_status: failed ? nil : "none"))
            }
            if mode.hasPrefix("same-live") {
                return try decode(LinkPreview(ok: true, status: "ready", url: nil, normalized_url: nil,
                    platform: "bilibili", extractor: "BiliBiliLive", title: "特斯拉ROADSTER发布会（回放）",
                    thumbnail: sameLiveThumbnail, uploader: "发布会官方", duration: 0, estimated_bytes: nil,
                    message: "预读完成", live_status: "live", started_at: liveStart, category: "科技"))
            }
            if mode.hasPrefix("tracks") {
                // 与 YouTube 实际返回一致：原语言自动字幕 + 平台自动翻译。
                let long = mode == "tracks-long"
                let original = long ? "zh-Hant-TW" : "en"
                let tracks = [
                    SubtitleTrack(id: original.lowercased() + ":automatic", language: original, kind: "automatic",
                                  name: "English", source_language: "en", is_original: true),
                    SubtitleTrack(id: "zh-hans:translated", language: "zh-Hans", kind: "translated",
                                  name: "Chinese", source_language: "en", is_original: false),
                    SubtitleTrack(id: "zh-hant:translated", language: "zh-Hant", kind: "translated",
                                  name: "Chinese", source_language: "en", is_original: false)]
                return try decode(LinkPreview(ok: true, status: "ready", url: nil, normalized_url: nil,
                    platform: "youtube", extractor: nil,
                    title: "Alexandr Wang: “This is a Once-in-a-Civilization Opportunity”",
                    thumbnail: nil, uploader: "Y Combinator", duration: 1930, estimated_bytes: nil,
                    message: "预读完成", subtitle_status: "available", subtitle_language: original,
                    subtitle_kind: "automatic", subtitle_tracks: tracks, original_language: original,
                    default_subtitle_track_id: tracks[0].id, subtitle_selection_required: false))
            }
            return try decode(LinkPreview(ok: mode != "failed", status: mode == "failed" ? "error" : "ready",
                                          url: nil, normalized_url: nil, platform: "bilibili", extractor: nil,
                                          title: mode == "long" ? String(repeating: "产品设计与新品发布会完整回放 ", count: 8) : "产品设计：从想法到发布",
                                          thumbnail: nil, uploader: "设计工作室",
                                          duration: 1860, estimated_bytes: nil, message: "暂时无法读取视频，请重试",
                                          subtitle_status: "available", subtitle_language: "zh-Hans", subtitle_kind: "manual"))
        }
        creates += 1
        if path == "/api/link-videos/batch" {
            return try decode(LinkBatchResult(ok: true, results: [LinkBatchItemResult(ok: true, id: "fixture",
                title: "视频", url: nil, duplicate: nil, message: nil, preview: nil)]))
        }
        return try JSONDecoder().decode(T.self, from: Data("{\"id\":\"fixture\"}".utf8))
    }
    private func decode<T: Decodable, V: Encodable>(_ value: V) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }
    private var sameLiveThumbnail: String? {
        if mode == "same-live-no-cover" { return nil }
        return coverBaseURL + (mode == "same-live-cover-failed" ? "/missing.png" : "/cover.png")
    }
    static let readyStatus = AsrStatus(state: "ready", downloaded: 0, total: 0, speed: 0, eta: nil, error: "",
        endpoint: "", current_file: "", model: "fixture", runtime: true, runtime_message: "", ready: true, size_on_disk: 0)
    static let readyOptions = MeetingOptions(languages: [MeetingLanguage(id: "", name: "自动识别"),
        MeetingLanguage(id: "zh", name: "中文")], aligner_ready: true, aligner_state: "ready", asr_ready: true,
        diarize: DiarizeStatus(available: true, package: true, model_ready: true, model_state: "ready", reason: ""))
}

@MainActor final class SessionStore: ObservableObject {
    static let shared = SessionStore()
    @Published var sessions: [SessionSummary] = []
}
@MainActor final class CalendarStore {
    static let shared = CalendarStore()
    func changed() {}
}
struct SessionStatusStyle {
    let status: String
    var isActive: Bool { ["queued", "recording", "processing", "pending"].contains(status) }
}
struct NewSheetRequest: Identifiable {
    let id = UUID()
    var kind: NewKind?
    var url: String?
    var file: URL?
    var calendarEventID: String? = nil
    var calendarEventTitle: String? = nil
}
@MainActor enum ClipboardLink { static func liveURLIfAllowed() -> String? { nil } }
@MainActor enum KeyRouter {
    static func liveText(or fallback: String) -> String {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.string ?? fallback
    }
}
struct InlineError: View {
    let text: String
    var compact = true
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(compact ? .caption : .callout).foregroundStyle(.red)
            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
}

@main struct NewCapturePreview {
    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        Task { @MainActor in
            do {
                let covers = try PreviewCoverServer()
                defer { covers.listener.cancel() }
                Backend.shared.coverBaseURL = try await covers.start()
                try await snapshots()
                precondition(covers.receivedRequests > 0, "Native cover loader must request the local image fixture")
                exit(0)
            }
            catch { print("Preview failed: \(error)"); exit(1) }
        }
        NSApp.run()
    }

    @MainActor static func snapshots() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/meetclip-new-capture-preview")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for platform in MediaPlatform.allCases {
            let url = Bundle.module.url(forResource: platform.rawValue, withExtension: "pdf")!
            precondition(NSImage(contentsOf: url) != nil, "Logo PDF must load offline")
        }
        var scenarios: [(String, NewKind, String?, URL?, String, Bool)] = [
            ("launch-empty", .launch, nil, nil, "ready", false),
            ("video-empty", .linkVideo, nil, nil, "ready", false),
            ("meeting-empty", .meeting, nil, nil, "ready", false),
            ("launch-ready", .launch, "https://live.bilibili.com/123", nil, "ready", false),
            ("video-ready", .linkVideo, "https://www.bilibili.com/video/BV123", nil, "ready", false),
            ("meeting-ready", .meeting, nil, URL(fileURLWithPath: "/tmp/产品周会.m4a"), "ready", false),
            ("launch-failed", .launch, "https://live.bilibili.com/123", nil, "failed", false),
            ("video-failed", .linkVideo, "https://www.bilibili.com/video/BV123", nil, "failed", false),
            ("video-loading", .linkVideo, "https://youtu.be/123", nil, "loading", false),
            ("video-batch", .linkVideo, "https://youtu.be/a\nhttps://youtu.be/b\nhttps://youtu.be/c", nil, "ready", false),
            ("video-models", .linkVideo, nil, nil, "models", false),
            ("meeting-models", .meeting, nil, nil, "models", false),
            ("launch-dark", .launch, "https://live.bilibili.com/123", nil, "ready", true),
            ("video-dark", .linkVideo, "https://youtu.be/123", nil, "ready", true),
            ("meeting-dark", .meeting, nil, URL(fileURLWithPath: "/tmp/产品周会.m4a"), "ready", true),
            ("launch-long-link", .launch, "https://live.bilibili.com/5146309?session_id=" + String(repeating: "a", count: 120), nil, "ready", false),
            ("video-long-link", .linkVideo, "https://www.bilibili.com/video/BV123?session_id=" + String(repeating: "b", count: 120), nil, "long", false),
            ("meeting-speakers", .meeting, nil, URL(fileURLWithPath: "/tmp/产品周会.m4a"), "ready", false),
            ("meeting-speakers-dark", .meeting, nil, URL(fileURLWithPath: "/tmp/产品周会.m4a"), "ready", true),
            ("meeting-long-file", .meeting, nil, URL(fileURLWithPath: "/tmp/" + String(repeating: "产品讨论与设计方案评审", count: 8) + ".m4a"), "ready", false),
            ("same-live-launch", .launch, "https://live.bilibili.com/5146309?visit_id=example", nil, "same-live", false),
            ("same-live-video", .linkVideo, "https://live.bilibili.com/5146309?visit_id=example", nil, "same-live", false),
            ("same-live-launch-dark", .launch, "https://live.bilibili.com/5146309", nil, "same-live", true),
            ("same-live-video-dark", .linkVideo, "https://live.bilibili.com/5146309", nil, "same-live", true),
            ("same-live-launch-no-cover", .launch, "https://live.bilibili.com/5146309", nil, "same-live-no-cover", false),
            ("same-live-video-no-cover", .linkVideo, "https://live.bilibili.com/5146309", nil, "same-live-no-cover", false),
            ("same-live-launch-cover-failed", .launch, "https://live.bilibili.com/5146309", nil, "same-live-cover-failed", false),
            ("same-live-video-cover-failed", .linkVideo, "https://live.bilibili.com/5146309", nil, "same-live-cover-failed", false),
            ("video-tracks", .linkVideo, "https://www.youtube.com/watch?v=sJ4VJWycX9M", nil, "tracks", false),
            ("video-tracks-long", .linkVideo, "https://www.youtube.com/watch?v=sJ4VJWycX9M", nil, "tracks-long", false),
            ("video-tracks-dark", .linkVideo, "https://www.youtube.com/watch?v=sJ4VJWycX9M", nil, "tracks", true),
            ("video-tracks-loading", .linkVideo, "https://www.youtube.com/watch?v=sJ4VJWycX9M", nil, "loading", false),
            ("video-x-ready", .linkVideo, "https://x.com/example/status/123456?s=46&t=share", nil, "x-ready", false),
            ("video-x-dark", .linkVideo, "https://twitter.com/example/status/123456/video/2", nil, "x-ready", true),
            ("video-x-login", .linkVideo, "https://x.com/example/status/123456", nil, "x-login", false),
        ]
        if ProcessInfo.processInfo.environment["MEETCLIP_LIVE_PREVIEW_JSON"] != nil {
            scenarios.append(("launch-real-metadata", .launch, "https://live.bilibili.com/32111849", nil, "real-live", false))
        }
        for (name, kind, url, file, mode, dark) in scenarios {
            let backend = Backend.shared
            backend.mode = mode
            backend.asr = mode == "models" ? nil : Backend.readyStatus
            backend.aligner = mode == "models" ? nil : Backend.readyStatus
            backend.meetingOptions = mode == "models" ? nil : Backend.readyOptions
            let sheet = NewCaptureSheet(request: NewSheetRequest(kind: kind, url: url, file: file), onCreated: { _ in })
                .environmentObject(backend)
                .environment(\.captureLayoutProbe) { id, rect in frames[id] = rect }
                .preferredColorScheme(dark ? .dark : .light)
            frames = [:]
            let host = NSHostingView(rootView: sheet)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.title = "新建界面验证"
            window.contentView = host
            window.center(); window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            try await Task.sleep(for: .milliseconds(950))
            precondition(host.bounds.width == 560 && host.bounds.height == 600, "Sheet geometry changed")
            if name.contains("speakers") {
                guard let toggle = descendants(host).first(where: { String(describing: type(of: $0)) == "PlatformSwitch" }) else {
                    preconditionFailure("Meeting form must expose a native speaker switch")
                }
                click(toggle.convert(NSPoint(x: toggle.bounds.midX, y: toggle.bounds.midY), to: nil), in: window)
                try await Task.sleep(for: .milliseconds(150))
            }
            checkLayout(host, meeting: kind == .meeting, tracks: mode.hasPrefix("tracks"))
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-l", "\(window.windowNumber)", output.appendingPathComponent(name + ".png").path]
            try capture.run(); capture.waitUntilExit()
            if capture.terminationStatus != 0 {
                guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Cannot render preview") }
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
            }
            print("PASS: \(name), content 560 × 600")
            window.orderOut(nil)
        }
        precondition(Backend.shared.creates == 0, "Snapshots must not submit tasks")
        print("All UI snapshots captured at \(output.path)")
        try await interactions()
    }

    @MainActor static func interactions() async throws {
        let backend = Backend.shared
        backend.mode = "ready"
        backend.asr = Backend.readyStatus
        backend.aligner = Backend.readyStatus
        backend.meetingOptions = Backend.readyOptions
        backend.requests = []
        var created: [String] = []
        let host = NSHostingView(rootView: NewCaptureSheet(request: NewSheetRequest(kind: .launch,
            file: URL(fileURLWithPath: "/tmp/会议.m4a")), onCreated: { created.append($0) }).environmentObject(backend))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        try await Task.sleep(for: .milliseconds(250))

        func fields() -> [NSTextField] {
            descendants(host).compactMap { $0 as? NSTextField }.filter { $0.isEditable }
        }
        func edit(_ field: NSTextField, _ value: String) {
            field.stringValue = value
            field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        }
        func switchTab(_ index: Int) async throws {
            // Exercise the glass buttons through native mouse dispatch.
            let inset = Metrics.Space.xs
            let width = (CaptureLayout.switcherWidth - 2 * inset) / 3
            let left = host.bounds.width - Metrics.Space.xl - CaptureLayout.scrollInset - CaptureLayout.switcherWidth
            let point = NSPoint(x: left + inset + width / 2 + CGFloat(index) * width,
                                y: host.bounds.height - Metrics.Space.xl - 20)
            click(point, in: window)
            try await Task.sleep(for: .milliseconds(250))
            precondition(host.bounds.width == 560 && host.bounds.height == 600)
        }
        func enter() {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
                isARepeat: false, keyCode: 36)!
            window.sendEvent(event)
        }

        edit(fields()[0], "https://live.bilibili.com/123")
        try await Task.sleep(for: .milliseconds(650))
        precondition(backend.requests.filter { $0.0 == "/api/precheck" }.count == 1)
        try await switchTab(1)
        precondition(fields()[0].stringValue.isEmpty)
        edit(fields()[0], "https://youtu.be/a\nhttps://youtu.be/b\nhttps://youtu.be/c")
        try await Task.sleep(for: .milliseconds(650))
        precondition(fields().map(\.stringValue) == ["https://youtu.be/a", "https://youtu.be/b", "https://youtu.be/c"])
        let previewCount = backend.requests.filter { $0.0 == "/api/link-videos/preview" }.count
        precondition(previewCount == 3)
        try await switchTab(2)
        let title = fields().first { $0.placeholderString == "默认使用文件名" }!
        edit(title, "保留的会议标题")
        try await switchTab(1)
        precondition(fields().map(\.stringValue) == ["https://youtu.be/a", "https://youtu.be/b", "https://youtu.be/c"])
        precondition(backend.requests.filter { $0.0 == "/api/link-videos/preview" }.count == previewCount)
        try await switchTab(0)
        precondition(fields()[0].stringValue == "https://live.bilibili.com/123")
        precondition(backend.requests.filter { $0.0 == "/api/precheck" }.count == 1)
        print("PASS: Native tab switching preserves inputs, metadata, and fixed geometry")

        enter()
        try await Task.sleep(for: .milliseconds(250))
        precondition(backend.requests.filter { $0.0 == "/api/sessions" }.count == 1)
        try await switchTab(1)
        enter()
        try await Task.sleep(for: .milliseconds(250))
        let batch = backend.requests.first { $0.0 == "/api/link-videos/batch" }!.1
        precondition((batch["items"] as? [[String: String]])?.count == 3)
        try await switchTab(2)
        precondition(fields().first { $0.placeholderString == "默认使用文件名" }?.stringValue == "保留的会议标题")
        enter()
        try await Task.sleep(for: .milliseconds(250))
        let imported = backend.requests.first { $0.0 == "/api/meetings/import" }!.1
        precondition(imported["title"] as? String == "保留的会议标题")
        precondition(created.count == 3)
        print("PASS: Return submits only the visible launch/video/meeting form with its preserved input")
        window.orderOut(nil)
    }

    @MainActor static func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    /// 按无障碍标识查找 SwiftUI 元素，返回它在 host 坐标系里的位置。
    /// 生产视图通过 captureLayoutProbe 回报的 SwiftUI 位置（窗口坐标，原点在左上）。
    @MainActor static var frames: [String: CGRect] = [:]

    @MainActor static func element(_ identifier: String) -> CGRect {
        guard let rect = frames[identifier] else {
            preconditionFailure("Missing layout probe \(identifier); found \(frames.keys.sorted())")
        }
        return rect
    }

    @MainActor static func click(_ point: NSPoint, in window: NSWindow) {
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                pressure: type == .leftMouseDown ? 1 : 0)!
            window.sendEvent(event)
        }
    }

    @MainActor static func checkLayout(_ host: NSView, meeting: Bool, tracks: Bool = false) {
        let views = descendants(host)
        precondition(!views.contains { $0 is NSSegmentedControl }, "Type switcher must use glass buttons")
        precondition(!views.contains { $0 is NSPopUpButton }, "New-capture menus must use glass menus, not pop-up buttons")
        guard let clip = views.compactMap({ $0 as? NSClipView }).first else { preconditionFailure("Missing scroll viewport") }
        let fields = views.compactMap { $0 as? NSTextField }.filter { $0.isEditable }
        for field in fields {
            let rect = field.convert(field.bounds, to: clip)
            precondition(rect.minX - 4 >= clip.bounds.minX && rect.maxX + 4 <= clip.bounds.maxX,
                         "Native focus ring is clipped horizontally")
        }
        if tracks {
            // 预读卡片、两个菜单和提示文字共用一条左边线。
            let field = element("capture.video.field")
            let mode = element("capture.video.transcription-mode")
            let language = element("capture.video.subtitle-language")
            let hint = element("capture.video.subtitle-hint")
            let card = element("capture.preview.card")
            let edges = [mode.minX, hint.minX, card.minX]
            precondition(edges.allSatisfy { abs($0 - field.minX) <= 1 }, "Video options are not left aligned: \(field.minX), \(edges)")
            precondition(abs(mode.midY - language.midY) <= 1, "Menus must share a row")
            precondition(abs(mode.height - 32) <= 1 && abs(language.height - 32) <= 1, "Menus must be 32 pt tall: \(mode.height), \(language.height)")
            precondition(abs(language.minX - mode.maxX - Metrics.Space.s) <= 1, "Menus must be 8 pt apart")
            precondition(language.width <= 280 + 40, "Language menu exceeds its maximum width: \(language.width)")
            precondition(abs(mode.minY - card.maxY - Metrics.Space.s) <= 1, "Card and menus must be 8 pt apart: \(mode.minY - card.maxY)")
            precondition(abs(hint.minY - mode.maxY - Metrics.Space.xs) <= 1, "Hint must sit 4 pt under the menus: \(hint.minY - mode.maxY)")
            print("LAYOUT field=\(field.minX) card=\(card.minX) mode=\(mode) language=\(language) hint=\(hint.minX)")
        }
        if meeting {
            let title = fields.first { $0.placeholderString == "默认使用文件名" }!
            let left = title.convert(title.bounds, to: host).minX
            let editor = views.compactMap { $0 as? NSTextView }.first { !$0.isFieldEditor }!
            let toggle = views.first { String(describing: type(of: $0)) == "PlatformSwitch" }!
            let editorRect = editor.enclosingScrollView!.convert(editor.enclosingScrollView!.bounds, to: host)
            let titleRect = title.convert(title.bounds, to: host)
            // Menu pickers expose a native focus proxy instead of NSPopUpButton on macOS 27.
            let picker = views.first {
                let rect = $0.convert($0.bounds, to: host)
                return String(describing: type(of: $0)) == "KeyViewProxy" &&
                    rect.midY > titleRect.midY && rect.midY < editorRect.minY
            }!
            let edges = [picker.convert(picker.bounds, to: host).minX, editorRect.minX,
                         toggle.convert(toggle.bounds, to: host).minX]
            precondition(edges.allSatisfy { abs($0 - left) <= 1 }, "Meeting controls do not share a leading edge: \(left), \(edges)")
        }
    }
}
