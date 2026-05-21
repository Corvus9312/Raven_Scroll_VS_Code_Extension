import * as vscode from 'vscode';

export function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function decodeBytes(bytes: Uint8Array): string {
    let data = bytes;
    if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
        data = data.slice(3);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        try {
            return new TextDecoder('gb18030').decode(data);
        } catch {
            return new TextDecoder('utf-8').decode(data);
        }
    }
}

export function buildReaderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'reader.css'));
    const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'reader.js'));
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net`,
        `font-src https://fonts.gstatic.com https://cdn.jsdelivr.net`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cutive+Mono&display=swap">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-tc-webfont@latest/style.css">
  <link rel="stylesheet" href="${cssUri}">
  <title>TXT Reader</title>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div id="sidebar-header">
      <span id="book-title"></span>
      <button id="btn-close-sidebar" title="關閉目錄">✕</button>
    </div>
    <div id="search-wrap">
      <input id="chapter-search" type="text" placeholder="搜尋章節…" autocomplete="off">
    </div>
    <ul id="chapter-list"></ul>
  </aside>
  <div id="main">
    <div id="toolbar">
      <button id="btn-sidebar" title="目錄 (Ctrl+\\)">☰</button>
      <div class="sep"></div>
      <button id="btn-font-dec" title="縮小字體">A−</button>
      <span id="font-label">18</span>
      <button id="btn-font-inc" title="放大字體">A+</button>
      <div class="sep"></div>
      <button id="btn-lh-dec" title="縮小行距">↕−</button>
      <span id="lh-label">2.1</span>
      <button id="btn-lh-inc" title="放大行距">↕+</button>
      <div class="sep"></div>
      <select id="font-select" title="字型">
        <option value="lxgw">霞鶩文楷</option>
        <option value="serif">明體</option>
        <option value="sans">黑體</option>
        <option value="kaiti">楷體</option>
        <option value="fangsong">仿宋</option>
        <option value="cutive">Cutive Mono</option>
      </select>
      <div class="sep"></div>
      <button id="btn-theme" title="切換深色／淺色">◑</button>
      <div class="spacer"></div>
      <span id="progress-label">0%</span>
    </div>
    <div id="reader-scroll">
      <div id="reader-body">
        <div id="loading">載入中…</div>
        <pre id="content"></pre>
        <div id="next-book-banner">
          <p>已到結尾</p>
          <button id="btn-next-book"></button>
        </div>
      </div>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
