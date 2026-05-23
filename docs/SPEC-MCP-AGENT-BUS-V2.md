# SPEC — MCP/CLI Onda v2 (agent-bus ready)

Status: **DRAFT**, awaiting Mario review
Author: Kai
Date: 2026-05-20
Target: `onda-mcp` (+ minimal companion changes in `onda-electron` IPC surface)

---

## 1. Motivation

Lo scenario reale osservato il 2026-05-20 (Alita in `00-Brandart-PM-OS` che delega a Nico in `06-Brandart/brandart-agentic-platform` via agent-bus) ha esposto i limiti del MCP attuale per workflow agentici cross-window. Gap concreti riscontrati:

- `onda_terminal_list` non distingue per workspace → Alita ha dovuto reverse-lookup via `cwd` tra 3 terminali candidati per capire quale fosse quello appena creato nel workspace BAP.
- Nessuna primitiva per "apri workspace X in window Y" o per **chiedere all'utente** dove aprirlo in caso di ambiguità (stessa window/mosaic vs nuova window).
- `onda_terminal_run` invia `command\n`: se l'agent deve passare un brief multi-line a `claude`, le righe vengono parsate come comandi separati. `onda_tab_exec` risolve il problema ma solo per nuove tab, non per terminali esistenti.
- Nessun handshake "PTY ready" dopo `onda_workspace_add_terminal` → race tra creazione terminale e primo `terminal_run`.

L'obiettivo di v2 è rendere il MCP **pilotabile da agent senza ambiguità** e **multi-window aware**, mantenendo la backward compatibility con i 24 tool esistenti.

## 2. Constraints / Non-goals

- **Backward compatibility**: i 24 tool esistenti restano invariati nel naming e nello schema obbligatorio. Aggiunte solo come campi opzionali sullo schema input e campi extra sull'output.
- **Non-goal**: ridisegnare il modello workspace/tab/pane. Onda v1.9 garantisce già che un workspace è **mounted in at most one window** (registry `mountedInWindow` in `src/main/window/workspace-mount-registry.ts`). La spec si appoggia su questo invariante.
- **Non-goal**: introdurre uno stato persistente dentro l'MCP server. L'MCP resta stateless; tutta la verità vive nel main process.
- **Non-goal**: CLI standalone separato. Il "CLI" è il MCP server invocato via stdio (già funzionante). Se serve un binario `onda` per script shell, è follow-up separato.

## 3. Concepts

### 3.1 Placement

`Placement` è un nuovo concetto **trasversale** ai tool che aprono workspace/terminal in una specifica window. Tipologia:

| Mode | Semantica |
|------|-----------|
| `auto` (default) | Se workspace già mounted in qualche window → focus quella. Altrimenti mount nella window focused. |
| `current-window` | Forza mount nella window focused (se workspace già altrove, **transfer**). |
| `window:<windowId>` | Mount nella window specifica (transfer se necessario). Fallisce se windowId inesistente. |
| `new-window` | Apri una nuova BrowserWindow e monta lì il workspace. |
| `ask-user` | **Non procedere**. Ritorna `{ needsDecision: true, options: [...] }` con la lista di scelte possibili (window correnti + "new"). L'agent host è responsabile di girare la decisione all'utente e richiamare il tool con `placement` risolto. |

`ask-user` è il pattern interattivo richiesto da Mario: il MCP non blocca il flusso, restituisce un payload che permette all'agent (Claude Code o altro) di chiedere all'utente nel suo canale conversazionale.

### 3.2 Stable references

Riferimenti che restano validi cross-call:

- `windowId: string` — opaco, ottenuto da `onda_window_list`. Stabile per la vita della BrowserWindow.
- `workspaceId: string` — già esistente, stabile.
- `terminalId: string` — già esistente, stabile (PTY session). Sopravvive a split/merge di pane.
- `paneId: string` — già esistente, **cambia** su split/merge.

Tutti i tool che oggi accettano `id` ambigui (es. `onda_terminal_run.id`) **continuano a funzionare** ma diventano disambiguabili con un parametro opzionale `windowId`/`workspaceId` quando esistono collisioni teoriche.

## 4. New tools

### 4.1 `onda_window_list`

```jsonc
{
  "name": "onda_window_list",
  "input": {},
  "output": {
    "windows": [{
      "windowId": "string",
      "isFocused": "boolean",
      "title": "string | null",
      "workspaceIds": ["string"],          // workspace mounted in this window
      "activeWorkspaceId": "string | null",
      "uiMode": "tiled | classic"
    }]
  }
}
```

Impl: legge `getMainWindows()` + snapshot `mountedInWindow` registry + per ogni window query del renderer per active workspace.

### 4.2 `onda_workspace_locate`

```jsonc
{
  "name": "onda_workspace_locate",
  "input": {
    "name": "string?",          // one of name | id | rootPath required
    "id": "string?",
    "rootPath": "string?"
  },
  "output": {
    "workspace": {
      "id": "string",
      "name": "string",
      "rootPath": "string",
      "mountedIn": "string | null"   // windowId or null if not mounted
    } | null
  }
}
```

Risolve "esiste un workspace per X? dov'è?" senza dover scaricare la lista intera.

### 4.3 `onda_terminal_spawn`

Variant di `onda_tab_exec` ma su workspace **esistente** (no nuova tab). Spawna binario via execve nel PTY del pane target, preservando multi-line/quote/dollar:

```jsonc
{
  "name": "onda_terminal_spawn",
  "input": {
    "workspaceId": "string?",     // resolve target workspace, default: active
    "paneId": "string?",          // optional, default: active pane in workspace
    "bin": "string",              // PATH-resolvable or absolute
    "args": ["string"],           // argv verbatim
    "cwd": "string?",
    "placement": "string?"        // see §3.1, default 'auto'
  },
  "output": {
    "terminalId": "string",
    "paneId": "string",
    "workspaceId": "string",
    "windowId": "string",
    "pid": "number"
  }
}
```

**Use case prototipo**: avviare `claude` nel workspace BAP con un brief multi-line come prompt iniziale → `bin: "claude"`, `args: ["--", "Brief multi-line\nriga 2\nriga 3"]`. Il PTY riceve l'argv come singolo entry, nessuna re-interpretazione shell.

### 4.4 `onda_launch_session` (macro)

Tool composito atomico per lo scenario "agent delega a altro agent in altro workspace":

```jsonc
{
  "name": "onda_launch_session",
  "input": {
    "workspace": {
      "name": "string?",
      "id": "string?",
      "rootPath": "string?",
      "createIfMissing": "boolean?"   // default false
    },
    "bin": "string",                   // default 'claude' if omitted? TBD
    "args": ["string"],
    "prompt": "string?",               // alternative to args: passed as last argv element
    "placement": "string?",            // see §3.1
    "addTerminalIfNeeded": "boolean?"  // default true
  },
  "output": {
    "windowId": "string",
    "workspaceId": "string",
    "terminalId": "string",
    "paneId": "string",
    "pid": "number"
  }
}
```

Sequenza interna:

1. Risolvi workspace via `onda_workspace_locate` (or create se `createIfMissing`).
2. Risolvi placement:
   - Se `ask-user` → return early con `{ needsDecision: true, options: [...] }`.
   - Altrimenti calcola `targetWindowId` (esistente o nuova).
3. Se workspace non mounted in `targetWindowId` → `claimWorkspaceMount` / `transferWorkspaceMount`.
4. Se `addTerminalIfNeeded` e workspace non ha pane attivo terminale → add terminal e **attendi PTY-ready** (§4.5).
5. Spawna `bin` + `args` (o `prompt` come ultimo argv) nel pane risolto.
6. Return ID completi.

Nota: questo tool **non sostituisce** i primitivi sottostanti. Resta utile esporre i primitivi per workflow custom; `launch_session` è scorciatoia ergonomica.

### 4.5 PTY-ready handshake (modifica di `onda_workspace_add_terminal`)

Oggi `add_terminal` ritorna appena il pane è creato lato renderer, ma il PTY potrebbe non aver ancora completato `fork+exec` quando arriva il primo `terminal_run`. Modifica:

```jsonc
{
  "name": "onda_workspace_add_terminal",
  "input": { /* invariato + */
    "waitForReady": "boolean?"   // default true (breaking change soft: opt-out se serve vecchio comportamento)
  },
  "output": {
    "terminalId": "string",
    "paneId": "string",
    "workspaceId": "string",
    "windowId": "string",
    "ready": "boolean"            // true if PTY fully spawned, false if timeout
  }
}
```

Impl lato electron: il pty-subprocess emette già un evento `ready` quando il PTY è up; lo riusiamo per risolvere la promise IPC.

## 5. Enriched outputs (backward-compatible)

### 5.1 `onda_terminal_list`

Output esteso (campi nuovi opzionali in coda):

```jsonc
{
  "terminals": [{
    "id": "string",                 // = terminalId
    "pid": "number",
    "cwd": "string",
    "alive": "boolean",
    // new:
    "workspaceId": "string | null",
    "paneId": "string | null",
    "windowId": "string | null",
    "tabId": "string | null",
    "foregroundCommand": "string | null"   // se gia cached (vedi screenshot-ipc cachedForegroundCommand)
  }]
}
```

Input esteso (filtro opzionale):

```jsonc
{
  "input": {
    "workspaceId": "string?",
    "windowId": "string?"
  }
}
```

### 5.2 `onda_workspace_list`

Aggiunge `mountedIn: string | null` (windowId) per ogni workspace.

### 5.3 `onda_status`, `onda_context`

Aggiungono `windowId` ovunque ci sia un riferimento a workspace/pane.

## 6. Companion changes in onda-electron

Necessari per supportare i nuovi tool MCP:

1. **IPC handler `mcp:window-list`** in main: ritorna roster window + workspaceIds per ciascuna. Già parzialmente coperto da `listMainWindows()` + `snapshotMountRegistry()`, va solo wrappato in un singolo handler per ridurre round-trip.
2. **IPC handler `mcp:terminal-list-enriched`**: oggi `terminal_list` legge dal terminal-manager (PTY-side), non sa di workspace/pane. Serve un handler che fa il join terminal-manager ↔ tabStore/workspaceStore mirror nel main. Il mirror esiste già (`mw:sync` intercept).
3. **PTY-ready event surfacing**: il `pty-subprocess` emette già readiness; va propagato come Promise resolution dell'IPC `workspace:add-terminal`.
4. **`mcp:spawn-in-pane`**: nuovo IPC che, dato `paneId`, spawna un binario via `execve` nel PTY associato. Analogo a quello che fa `tab_exec` ma su pane esistente. Implica refactor minimo del terminal-manager per supportare "replace shell with bin" su PTY già attivo — **da verificare fattibilità** (potrebbe richiedere kill + respawn, da chiarire prima di implementare; in alternativa il `terminal_spawn` può degradare a "scrivi `exec bin args...` nel PTY se il PTY è una shell vuota").
5. **`mcp:new-window`**: espone `spawnNewMainWindow()` via IPC (oggi è solo main-process). Necessario per `placement: 'new-window'`.

⚠️ Punto 4 è il rischio principale di scope creep. Soluzione di fallback: **non supportare `terminal_spawn` su pane esistenti con PTY già occupato**; se il pane ha già una shell con processi vivi, `terminal_spawn` fallisce con `{ error: "pane busy", suggestion: "use add_terminal first" }`. Per pane "fresh" (shell appena spawnata, no comando in corso) si può fare `exec bin args...` scritto nel PTY.

## 7. Pattern `ask-user` — protocollo

Quando un tool ritorna `{ needsDecision: true, options }`, l'agent host (Claude Code) deve:

1. Presentare le `options` all'utente.
2. Ricevere la scelta.
3. Richiamare lo **stesso** tool con argomenti identici + `placement: "<resolved-value>"`.

Esempio:

```jsonc
// Call 1
onda_launch_session({
  workspace: { name: "brandart-agentic-platform" },
  bin: "claude",
  prompt: "Scaffold modulo memoria...",
  placement: "ask-user"
})

// Response
{
  "needsDecision": true,
  "reason": "workspace not mounted, multiple windows available",
  "options": [
    { "placement": "window:win-abc", "label": "Onda main window (current)" },
    { "placement": "window:win-def", "label": "Onda secondary window (work-hub)" },
    { "placement": "new-window", "label": "Open in new window" }
  ]
}

// Agent asks user, gets answer "current window"

// Call 2 (with resolved placement)
onda_launch_session({ /* same args */, placement: "window:win-abc" })
// → returns full IDs as normal
```

Nota: il MCP **non ricorda** la prima call. È stateless. L'agent host deve ri-inviare tutti gli argomenti.

## 8. Tool surface summary

| Tool | Status v2 | Notes |
|------|-----------|-------|
| `onda_pane_*` (4) | unchanged | Mantengono attuale signature |
| `onda_terminal_run/send/kill` | unchanged | |
| `onda_terminal_list` | **enriched** | + workspaceId, paneId, windowId, tabId, fg cmd + input filters |
| `onda_terminal_spawn` | **NEW** | §4.3 |
| `onda_tab_*` (5) | unchanged | `tab_exec` resta utile per "nuova tab + spawn" |
| `onda_workspace_list` | **enriched** | + mountedIn windowId |
| `onda_workspace_create/focus/add_terminal/tile` | mostly unchanged | `add_terminal` aggiunge `waitForReady` + arricchisce output |
| `onda_workspace_locate` | **NEW** | §4.2 |
| `onda_window_list` | **NEW** | §4.1 |
| `onda_launch_session` | **NEW** | §4.4 — macro |
| `onda_context/status/app_info/ping` | enriched | + windowId in payloads |

Totale: 24 tool oggi → 27 tool v2 (24 invariati o arricchiti + 3 nuovi). `onda_launch_session` è la "killer feature" per scenari agent-bus.

## 9. Open questions

1. **Default `bin` in `launch_session`**: hardcode `"claude"` o richiedi sempre esplicito? *Proposta*: richiedi esplicito, ma documenta `claude` come pattern principale.
2. **`terminal_spawn` su pane occupato**: hard-fail o consenti `exec` write nel PTY anche se shell ha già processi? *Proposta*: hard-fail con suggestion.
3. **Permessi**: oggi il MCP non ha alcun gate. Vogliamo opt-in per tool "intrusivi" come `new-window` o `transfer_workspace`? *Proposta*: lasciamo aperto in v2, valutiamo se Mario riceve abusi.
4. **CLI binary `onda`**: separato dal MCP server? Use case: invocazione da hook shell, scripting bash. *Proposta*: out of scope v2, follow-up se serve.
5. **Notifica visiva quando agent muove workspace tra window**: oggi se Alita transfer-a un workspace da window A a window B, Mario lo vede solo quando guarda la window. Vogliamo un toast? *Proposta*: out of scope v2.

## 10. Implementation plan (post-approval)

Effort stimato: ~1.5 giornate, in due fasi che possono essere shippate separatamente.

**Fase A — Enrichment + multi-window (≈ 6h)**
- Companion change #1 (`mcp:window-list` handler)
- Companion change #2 (`mcp:terminal-list-enriched`)
- `onda_window_list`, `onda_workspace_locate`
- Arricchimento `terminal_list`, `workspace_list`, `status`, `context`
- Test manuali multi-window

**Fase B — Spawn + macro (≈ 6h)**
- Companion change #3 (PTY-ready handshake)
- Companion change #4 (`mcp:spawn-in-pane`) **con fallback hard-fail su pane occupato**
- Companion change #5 (`mcp:new-window`)
- `onda_terminal_spawn`, `onda_launch_session`
- Test end-to-end con scenario Alita→Nico reale

**Fase C — Polish (≈ 2h)**
- README onda-mcp aggiornato
- Esempio agent-bus integration nel persona file di Alita

## 11. Acceptance criteria

Una volta implementato, lo scenario di Alita osservato il 2026-05-20 deve diventare:

```
onda_launch_session({
  workspace: { name: "brandart-agentic-platform" },
  bin: "claude",
  prompt: "<brief BAP scaffold memoria>",
  placement: "ask-user"
})
→ user picks "current window"
→ workspace mounted + terminal added + claude spawned with brief
→ Alita riceve { windowId, workspaceId, terminalId, paneId, pid }
```

Niente reverse-lookup via cwd. Niente race su PTY-ready. Niente brief spezzato in righe-comando. L'utente sceglie esplicitamente dove aprire quando c'è ambiguità.

---

**FINE DRAFT.** Pronto per review.
