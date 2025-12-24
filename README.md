# Win11 XHS Recipe Extractor (MVP)

Windows 11 desktop app (Electron) that:
- Accepts a Xiaohongshu share URL
- Uses an **Xiaohongshu MCP server** tool to fetch caption + images
- Sends caption + selected image to **OpenAI Chat Completions**
- Returns a bilingual (中文/English) Markdown recipe for copy/export

## Prereqs
- Windows 11
- Node.js 20+ (Node 24 works)
- An OpenAI API key
- A working **XHS MCP server** installed locally (this app connects to it via MCP stdio)

## Run (dev)
```powershell
npm install
npm run dev
```

## Configure
Create a `.env` file (see `.env.example`) and set:
- `OPENAI_API_KEY`
- Optional: `OPENAI_MODEL` (default: `gpt-4o-mini`)

Then open **Settings** in the app and set:
- **MCP Transport**
  - **HTTP**: for `xpzouying/xiaohongshu-mcp` (runs at `http://localhost:18060/mcp`)
  - **Stdio**: for custom MCP servers you launch via command/args
- **HTTP mode**: set **MCP HTTP URL** to `http://localhost:18060/mcp` (default) and optionally set **MCP Tool Name** to `get_feed_detail`
- **Stdio mode**: set **MCP Command / Args** to launch your MCP server
  - Example: `npx` + args like `-y <your-mcp-package>`
  - Tool name is optional; if empty, the app will try to auto-detect a suitable tool

## Notes
- If the MCP server returns image URLs that require auth headers, the app may be unable to download them for OpenAI. In that case it will still generate a best-effort recipe from the caption alone.
- For `xpzouying/xiaohongshu-mcp`, the `get_feed_detail` tool needs a URL that includes `xsec_token`. If a short share URL doesn't contain it, the app will try to resolve redirects; if it still can't find it, open the post in a browser and copy the full URL.
