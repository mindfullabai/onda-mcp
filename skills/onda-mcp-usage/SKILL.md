---
name: onda-mcp-usage
description: Best-practices per pilotare Onda (terminal emulator) da Claude Code via il server MCP `onda` (`mcp__onda__*`). Coprire workspaces/windows/panes/terminals + lettura buffer (read/subscribe/poll/wait_for/send_keys) + spatial awareness (layout/screenshot). Use ogni volta che chiami un tool `mcp__onda__*` o l'utente menziona Onda, pane, workspace, terminal listener, presence badge, inception loop (Claude controlla Onda da dentro Onda). Triggers — onda mcp, pilota onda, controlla terminale onda, mostra pane, layout workspace, screenshot onda, kai watcher, listener terminal.
metadata:
  version: 0.1.0
  source: '@mindfullabai/onda-mcp'
---

# Onda MCP usage skill

Questa skill ti dice **come usare correttamente i 38 tool `mcp__onda__*`** che il server `onda-mcp` espone. È installata insieme al server MCP. Senza questa guida sbatti contro pattern non ovvi (subscribe DOPO run perde output, mappatura `down`/`right` invertita pre-fix, refresh UI cache).

## Mental model

Tu (Claude Code) giri in **un terminale dentro Onda**. Il server `onda-mcp` parla all'app Onda host via JSON-RPC su UDS `~/.config/onda/onda.sock`. **Inception loop**: ogni tua azione tramite `mcp__onda__*` cambia l'app dove sei dentro. Tratta lo stato dei pane/workspace come **shared mutable** con l'utente — non assumere che resti com'era.

Onda ha tre primitive layout:
- **Window**: BrowserWindow Electron. N workspaces possono coabitare in un Window in tiled mode.
- **Workspace**: cartella radice + collezione di pane. Mountato su una Window.
- **Pane**: contenitore con `contentType: terminal | editor | diff`. I terminal hanno un `terminalId` stabile (sopravvive a split/merge).

Layout interno workspace = albero di mosaic-component. Lo leggi con `onda_workspace_layout`.

## Quando usare cosa — cheat sheet

| Goal | Tool |
|---|---|
| "Quali workspace esistono" | `onda_workspace_list` |
| "Quali Window aperte" | `onda_window_list` |
| "Com'è disposto il workspace X" | `onda_workspace_layout` |
| "Voglio vedere quello che vede l'utente" | `onda_window_screenshot` |
| "Apri un nuovo terminale a destra/sotto di pane X" | `onda_workspace_add_terminal` con `direction` + `relativeToPaneId` |
| "Leggi cosa ha stampato finora il terminale" | `onda_terminal_read` (no subscribe needed) |
| "Voglio sentire ogni nuovo output" | `subscribe` + loop di `poll` |
| "Aspetta che la build finisca" | `onda_terminal_wait_for` con regex |
| "Premi Ctrl+C / Up / Esc" | `onda_terminal_send_keys` (NO `terminal_send` con `"\x03"`!) |
| "Scrivi un comando ed eseguilo" | `onda_terminal_run` (testo + \n) |
| "Smonta listener quando hai finito" | `onda_terminal_unsubscribe` (SEMPRE) |
| "Lancia Claude Code in un nuovo pane con prompt" | `onda_terminal_spawn` con `bin=claude`, `args=[prompt]` |

## Pattern: lavorare con buffer terminale (lettura)

**Anti-pattern**: chiamare `terminal.run` e POI `terminal.read`. Il tap viene creato lazy al primo `read`/`subscribe`, e il PTY data emesso prima del tap **è perso**.

```
✗ run → read   (perdi l'output del run)
✓ read|subscribe → run → read|poll  (cattura tutto)
```

Ring buffer size:
- **200 KB** quando nessun listener (per `read`-only)
- **1 MB** quando c'è almeno un `subscribe` attivo

Per output high-throughput (`find /`, `tail -F` log), il ring satura. Usa `wait_for` con pattern preciso invece di subscribe + scan.

## Pattern: subscribe + poll loop

```
sub = subscribe(id, listener="kai-watcher")
loop {
  res = poll(sub.sessionId, timeoutMs=15000)
  for chunk in res.chunks: process(chunk.data)
}
unsubscribe(sub.sessionId)
```

`poll` è **long-poll**: si sblocca al primo `data` event oppure al timeout. Wake-up immediato su nuovo output. Cursor avanza solo a poll riuscita — niente replay.

**Cleanup obbligatorio**: chiama `unsubscribe` quando hai finito. TTL automatico è 30 min ma non affidarti.

## Pattern: scriptable terminal automation (tipo tmux)

```
sub = subscribe(id, "kai-script")           # opzionale, per log
send_keys(id, ["echo BUILD_START", "Enter"])
wait_for(id, /BUILD_START/)                  # sync barrier
send_keys(id, ["npm test", "Enter"])
wait_for(id, /PASS|FAIL|error/, timeoutMs=120000)
send_keys(id, ["Ctrl+C"])                    # cleanup
unsubscribe(sub.sessionId)
```

Keysym che funzionano in `send_keys`: `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`, `Up/Down/Left/Right`, `Home/End/PageUp/PageDown`, `Insert`, `Ctrl+<lettera>`, `F1`-`F12`. Tutto il resto viene mandato come testo letterale (utile per `["echo hello", "Enter"]`).

`send_keys` ≠ `terminal_send`: il primo mappa keysym semantici → byte ANSI. Il secondo manda testo raw. Per `Ctrl+C` usa SEMPRE `send_keys(["Ctrl+C"])`.

## Pattern: spatial-aware placement

**Anti-pattern**: spawnare panes con `add_terminal` plain e farli atterrare a caso. Cresce la finestra a destra all'infinito.

**Pattern corretto**:
```
layout = workspace_layout(workspaceId)
# layout.paneIds: [...]; layout.activePaneId; layout.viewport
# Decidi: stack down per output continui, split right per parallel-watch
new = workspace_add_terminal(workspaceId,
                              direction="down",
                              relativeToPaneId=layout.activePaneId)
```

Mappatura `direction`:
- `right` / `left` → side-by-side (left-right pair)
- `down` / `up` → stacked (top-bottom pair)
- `horizontal` = stacked (synonym di `down`)
- `vertical` = side-by-side (synonym di `right`)

Usa `down` quando il nuovo pane farà output continuo (log, build). Usa `right` per terminali di lavoro parallelo.

## Pattern: visual verification

Quando devi confermare visivamente che un'azione ha funzionato (layout cambiato, badge appare, modal aperta) usa `window_screenshot`:

```
screenshot = window_screenshot(windowId, format="jpeg", quality=72, dataUrl=false)
# returns path; usa Read sull'immagine
```

Default `dataUrl=true` ritorna base64 inline (~1-2 MB), `dataUrl=false` scrive tempfile e lo `Read` lo monta come immagine multimodal — preferito per non sprecare context.

## Pattern: lanciare Claude Code in un pane (inception)

```
pane = workspace_add_terminal(workspaceId="...", direction="right")
subscribe(pane.terminalId, "kai-watcher")     # PRIMA del lancio
terminal_spawn(pane.paneId, bin="claude", args=["--dangerously-skip-permissions", "prompt..."])
# Claude TUI mostra "Trust this folder?" prompt
send_keys(pane.terminalId, ["Enter"])         # conferma default highlighted (1. Yes)
# Da qui Claude lavora — usa wait_for con pattern di completamento atteso
wait_for(pane.terminalId, /===KAI_CHECK_DONE===/, timeoutMs=120000)
unsubscribe(...)
```

**Gotcha Claude TUI**: lo stream è MOLTO rumoroso (100+ chunk/sec di spinner ANSI). Preferisci `wait_for(pattern)` invece di `poll` continuo. Per debug visivo usa `screenshot` ogni 30s, NON read del buffer text.

## Cleanup discipline

**Sempre**:
- `unsubscribe(sessionId)` quando hai finito di leggere
- `pane_close(id)` per pane creati come test/scratch (NON pane utente esistenti — assumi siano di Mario)
- Prefissa listener name con il tuo identificativo (`kai-`, `alita-`, `ci-`) per leggibilità badge UI

**Non chiudere**:
- Pane originali dell'utente
- Workspace dell'utente (`workspace_focus` per switchare sì, ma niente `workspace_delete`)
- Window dell'utente (`window_new` OK, mai chiudere quelle esistenti)

## Anti-pattern catalog

1. **Subscribe per Claude TUI**: nope. Genera 100 chunk/sec di spinner. Usa `read` a intervalli + `wait_for` per pattern noti.
2. **`terminal_send` con bytes raw** (`"\x03"` per Ctrl+C): nope. Usa `send_keys(["Ctrl+C"])`.
3. **`workspace_add_terminal` senza prima `workspace_layout`**: ti rende cieco al placement. Append-right rapidamente diventa illeggibile.
4. **Listener senza unsubscribe**: leak per 30 min TTL. UI badge resta. Pulisci.
5. **`window_new`** quando l'utente vuole solo "un workspace in più sulla destra": NO — l'utente preferisce **mount workspace come tile nella window esistente** (oggi tool MCP per farlo manca → usa CLI a click manuale dall'utente con `dimmi quando hai cliccato`).
6. **Assumere che `app_info.name === "Onda-dev"`** distingua dev vs prod: NO. Usa `app_info.path` o flag esplicito.

## Conoscenza utile

- Username pane header listener badge: lampeggia blu, click apre popover con "kick" per terminare la session
- Onda-dev gira con bundle id `com.mariomosca.onda.dev` (sandboxed, non collide con prod)
- Onda usa **socket UDS** singolo, `~/.config/onda/onda.sock`. Quindi una sola istanza Onda risponde a MCP per volta (la prima ad aver fatto bind). Se vedi `app_info` con dati strani, magari sta parlando con un'istanza differente.
- Il MCP server mantiene il binding socket sino a quando l'app Onda master chiude — riavviare Onda da Cmd+Q + relaunch è il modo per "promuovere" un'altra istanza a master.

## Tool reference (38 totali)

Application:
- `onda_app_info` — version, pid, paths
- `onda_app_ping` — health check

Window (Electron BrowserWindow):
- `onda_window_list` — N window + workspaces[] per window
- `onda_window_new` — apre nuova Window vuota (usa con cautela, l'utente preferisce stesso window)
- `onda_window_screenshot` — PNG/JPEG snapshot del compositor (vedere quello che vede l'utente)

Workspace:
- `onda_workspace_list` — tutti i workspace + `mountedIn`
- `onda_workspace_locate` — find by name/id/rootPath
- `onda_workspace_create` — crea nuovo (rootPath required)
- `onda_workspace_focus` — switch sulla window focused
- `onda_workspace_layout` — mosaic tree + paneIds + activePaneId + viewport
- `onda_workspace_add_terminal` — spawn pane con direction opzionale
- `onda_workspace_tile` — set layout (split-h, split-v, quad)
- `onda_workspace_setLayout` — imposta layout custom

Pane:
- `onda_pane_list` — pane in window/workspace
- `onda_pane_focus` — focus pane
- `onda_pane_split` / `vsplit` / `hsplit` — split low-level (preferisci `workspace_add_terminal` con `direction`)
- `onda_pane_close` — close pane

Tab (legacy, prima del tiled-mode-first model):
- `onda_tab_new` / `list` / `close` / `focus` / `exec`

Terminal (control plane):
- `onda_terminal_list` — terminali attivi
- `onda_terminal_spawn` — exec binary (es. `claude`) dentro pane esistente
- `onda_terminal_send` — write raw text (NO newline)
- `onda_terminal_run` — send + newline
- `onda_terminal_resize` — cols/rows
- `onda_terminal_kill` — terminate PTY
- `onda_terminal_focus` — UI focus

Terminal (read/listen plane, M+1 2026-05-21):
- `onda_terminal_read` — snapshot ring buffer
- `onda_terminal_subscribe` — attach listener, return sessionId
- `onda_terminal_poll` — long-poll new chunks
- `onda_terminal_unsubscribe` — detach
- `onda_terminal_listeners` — chi sta ascoltando questo terminale
- `onda_terminal_wait_for` — block on regex match
- `onda_terminal_send_keys` — semantic keysym (Ctrl+C, Up, F5, ...)

Session:
- `onda_session_current` — sessione corrente del CLI consumer
- `onda_launchSession` — macro atomica "open workspace + add terminal + spawn bin"

## Versioning

Skill version: vedi `metadata.version` nel frontmatter. Bumpa quando aggiungi/rimuovi pattern o tool. Per re-installare l'ultima versione, riparte da `npx @mindfullabai/onda-mcp install-skill` (TODO) oppure copia manuale da `<onda-mcp-repo>/skills/onda-mcp-usage/`.
