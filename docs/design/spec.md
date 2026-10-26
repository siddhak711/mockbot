# mockbot · Cursor-style spec

- Neutral gray light theme (Mac app); warm near-black dark theme (#14120B, from cursor.com vars).
- Font: system SF Pro → Inter fallback. Mono: Berkeley Mono → JetBrains Mono. Text levels via opacity of ink (92/60/40%).
- Density: 34px sidebar rows, 14px items, 15/26 body (v2 after compare), 11–12px meta. Titlebar 40px with traffic lights, icon buttons 24px ghost.
- Sidebar: agents only. Each (user, agent) is one persistent thread, opened in full when the agent is selected. No New Chat, no conversation list, no rename, no delete, no Today or Last 7 Days groups. 34px rows; selected = #E2E2E2 r8. Routines and Connectors stay as nav actions. Theme toggle in the header.
- Transcript: no assistant bubble; bold lead-ins; links blue; row of 14px ghost icons (👍👎⧉) after reply; "Worked 14s" muted line. User msg = white card r10 hairline shadow, right-aligned, max 540.
- Tool calls: single muted line "◦ Read file.ts · +12 −3" in 13px, expandable; code/diff blocks r8 surface hairline mono 12/20; add/del tinted rows.
- Approval: compact card r10 surface, title 13/600, meta 12 muted, buttons right: secondary ghost "Skip", primary ink-filled "Run ⏎" r6 h26.
- Composer: white r12 hairline + soft shadow; placeholder muted; bottom row: mode chip "Agent ⌄", model "… ⌄" 11px muted, round 24px ink send.
- Buttons: primary ink bg/white text r6; secondary transparent + line-strong border; ghost text muted, hover bg #E9E9E9. Tabs: 12px, active = surface pill r6 + ink, inactive muted.
- Icons: 1.5px stroke line icons (Lucide-like), 16px.
