# feedback/ — recorded human feedback

English | [中文](README.zh.md)

The feedback family exposes editable feedback attached to one assistant message in a local sidecar. It never enters the model conversation.

| Package | Role | ctx key |
|---|---|---|
| `message-feedback/` | Lifecycle-bound per-message rating/note sidecar plus Host `messageFeedback.list/put/delete` Remote contract | `messageFeedback` |

Message feedback is not a Session event or projection. It remains in the storage-domain sidecar. The Host Remote contract ships with the service; the client Remote aggregate mount and UI consumer are separately owned and deferred.
