import Foundation

private func makeCoreDetail(id: String, count: Int) -> SessionDetail {
    let transcripts = (0..<count).map { index in
        Transcript(id: index + 1, session_id: id, start: Double(index) * 3,
                   end: Double(index) * 3 + 2.8,
                   text: String(repeating: "性能测试内容", count: 4),
                   speaker: index % 4 == 0 ? "S1" : nil)
    }
    return SessionDetail(id: id, title: "性能夹具", source_url: nil, status: "done",
        duration: Double(count * 3), media_path: nil, error: nil, started_at: nil,
        transcripts: transcripts, screenshots: [], marks: [], recording: false,
        processing: false, live: nil, has_video: false, asr_status: "done",
        stream_quality: nil, live_hls_path: nil, live_preview_path: nil, max_shots: nil)
}

@MainActor func runChecks() {
    let cache = SessionDetailCache(maxEntries: 8, maxAge: 60, memoryLimit: 128 * 1024 * 1024,
                                  now: { Date(timeIntervalSince1970: 100) })
    let first = SessionPresentation(makeCoreDetail(id: "first", count: 1_000))
    let second = SessionPresentation(makeCoreDetail(id: "second", count: 1_000))
    cache.insert(first); cache.insert(second)
    precondition(cache.presentation(for: "first") != nil)
    precondition(cache.presentation(for: "second") != nil)
    precondition(cache.estimatedBytes <= cache.memoryLimit)
    let third = SessionPresentation(makeCoreDetail(id: "third", count: 1_000))
    cache.insert(third)
    precondition(cache.count == 3)
    precondition(cache.presentation(for: "first", touch: false) != nil)

    let warmStart = DispatchTime.now().uptimeNanoseconds
    var samples: [Double] = []
    for _ in 0..<20 {
        let start = DispatchTime.now().uptimeNanoseconds
        _ = cache.presentation(for: "first")
        samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
    }
    let coldStart = DispatchTime.now().uptimeNanoseconds
    let cold = SessionPresentation(makeCoreDetail(id: "cold", count: 10_000))
    let coldMs = Double(DispatchTime.now().uptimeNanoseconds - coldStart) / 1_000_000
    let search = TranscriptSearchIndex(transcripts: cold.transcripts, query: "性能")
    precondition(cold.transcripts.count == 10_000 && !search.hits.isEmpty)
    precondition(cold.timeIndex.index(at: 30_000) != nil)
    samples.sort()
    let median = samples[samples.count / 2]
    let p95 = samples[min(samples.count - 1, Int(Double(samples.count) * 0.95))]
    precondition(coldMs < 500, "10,000-row normalization must meet the cold first-screen budget")
    precondition(median < 100, "Warm cache lookup must meet the 100 ms budget")
    let workloadMs = Double(DispatchTime.now().uptimeNanoseconds - warmStart) / 1_000_000
    print("PASS: session cache/index/search; cache median=\(median)ms p95=\(p95)ms coldPresentation=\(coldMs)ms total=\(workloadMs)ms bytes=\(cache.estimatedBytes)")
}

@main struct SessionPerformanceMain {
    @MainActor static func main() { runChecks() }
}
