# Backend fork

The FastAPI backend in `backend/app` is a fork of the original MeetClip macOS app's
backend, kept in-tree so the DSH plug-in can evolve independently.

- Forked: 2026-11-03 11:32:35 +0800
- Upstream: the original MeetClip macOS application (not part of this repository)
- Removed: the in-app Agent runtime, ACP/Codex integration, the stream proxy and
  `/api/agent` routes.
- Removed (0.5.0): local timestamp alignment (ForcedAligner) and speaker
  diarization (pyannote) dependencies plus their bundled models. Cloud
  transcription supplies pause-based timestamps; existing speaker labels stay
  read-only and `speakers_cloud.py` keeps the cloud diarization seam.
- Moved `app/agent/query_scope.py` to `app/query_scope.py`; `search_service`
  imports it directly.
- Additive: `/api/health` reports `data_dir` and `pid`; export responses include
  markdown.
- Additive (0.8.6): multiple libraries. `app/shared_paths.py` resolves
  `SHARED_DIR = MEETCLIP_SHARED_DIR or DATA_DIR`; `settings.py`, `bilibili.py`
  and `douyin.py` read cookies and shared settings from that directory. Without
  the environment variable the behaviour matches upstream. No database schema,
  media layout or Keychain service-name changes.
