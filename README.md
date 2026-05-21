# Corvus9312 BookReader

VSCode 擴充套件，讓你在 VSCode 裡舒適地閱讀 TXT 小說或文字書籍。支援章節導覽、自訂字型、閱讀進度記錄，以及 Google Drive 雲端書庫。

---

## 功能特色

- **TXT 閱讀器**：開啟 `.txt` 檔案時自動以閱讀模式呈現，而非原始文字編輯器
- **章節自動偵測**：識別「第X章」、「Chapter N」、序章、後記、番外等常見格式，並在側邊欄顯示目錄
- **閱讀進度自動儲存**：捲動後自動儲存進度，下次開啟從上次位置繼續
- **自訂外觀**：調整字型大小、行距、字型種類（含霞鶩文楷），以及深色 / 淺色主題
- **本機書庫**：管理多個本機資料夾，瀏覽資料夾內所有 TXT 書籍與閱讀進度
- **Google Drive 整合**：直接瀏覽並閱讀 Google Drive 上的 TXT 檔案，進度同步存於雲端
- **下一本書**：閱讀至接近結尾時，自動提示同目錄的下一本書

---

## 介面說明

擴充套件在左側活動欄新增一個書本圖示，包含三個面板：

| 面板 | 說明 |
|------|------|
| **書庫** | 管理本機 TXT 資料夾，顯示每本書的閱讀進度 |
| **最近閱讀** | 列出最近開啟的 50 本書 |
| **Google Drive** | 瀏覽並開啟 Google Drive 上的 TXT 檔案 |

閱讀器預設顯示在 VSCode 底部面板，可拖曳至主側邊欄或次側邊欄。

---

## 閱讀器操作

### 工具列

| 控制項 | 說明 |
|--------|------|
| ☰ | 開關章節目錄側邊欄 |
| A− / A+ | 縮小 / 放大字體（12–40px） |
| ↕− / ↕+ | 縮小 / 放大行距（1.2–3.5） |
| 字型選單 | 霞鶩文楷 / 明體 / 黑體 / 楷體 / 仿宋 / Cutive Mono |
| ◑ | 切換深色 / 淺色主題 |
| 右側百分比 | 目前閱讀進度 |

### 鍵盤快速鍵

| 按鍵 | 動作 |
|------|------|
| `Ctrl + \` | 開關章節目錄 |

### 章節目錄

- 點擊章節名稱可平滑捲動至該章節
- 目錄頂部提供搜尋欄，可快速篩選章節
- 目前閱讀位置對應的章節會自動 highlight

---

## 安裝與使用

### 安裝

1. 從 `release/` 資料夾取得 `.vsix` 檔案
2. 在 VSCode 中開啟指令面板（`Ctrl+Shift+P`），執行 **Extensions: Install from VSIX…**
3. 選擇 `.vsix` 檔案安裝

### 首次使用

1. 點擊左側活動欄的書本圖示
2. 在「**書庫**」面板點擊 `+` 新增包含 TXT 檔案的資料夾
3. 展開資料夾後點擊書名即可開始閱讀

---

## Google Drive 整合

### 事前準備

使用 Google Drive 功能前，需提供 Google OAuth2 憑證：

1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 **Google Drive API**
3. 建立 **OAuth 2.0 用戶端 ID**（類型選「桌面應用程式」）
4. 下載憑證 JSON，重新命名為 `credentials.json`
5. 將檔案放入擴充套件的 `media/` 資料夾

### 登入

在「**Google Drive**」面板點擊登入按鈕（或工具列的登入圖示），瀏覽器會開啟 Google 授權頁面，完成授權後即可瀏覽雲端書庫。

### 進度同步

Drive 上書籍的閱讀進度會儲存於 Google Drive 的 App 私有資料夾（`appDataFolder`），不會出現在你的 My Drive 中。

---

## 設定項目

| 設定 | 預設值 | 說明 |
|------|--------|------|
| `corvusTxtReader.openIn` | `panel` | 開啟 TXT 的位置：`panel`（底部面板）或 `editor`（標籤頁） |
| `corvusTxtReader.driveFolderUrl` | （空白） | Google Drive 書庫根目錄連結，留空則從 My Drive 根目錄開始 |

---

## 閱讀進度格式

本機書籍的進度存成與 TXT 同目錄的隱藏 JSON 檔案，命名規則為：

```
.corvus.{書名}.txt.json
```

內容範例：
```json
{ "scrollTop": 12480, "percent": 42 }
```

---

## 章節偵測規則

自動識別以下開頭的行（行長不超過 60 字元）：

- 中文章節：`第X章`、`第X節`、`第X回` 等（支援中文數字與阿拉伯數字）
- 英文章節：`Chapter 1`、`Chapter One` 等
- 特殊段落：序章、前言、後記、尾聲、番外、楔子、引子 等
- 數字編號：`1.`、`2、` 等接短標題

---

## 開發環境設定

### 1. 安裝依賴

```batch
npm install
```

### 2. 準備 Google Drive 憑證

`media/credentials.json` 已列入 `.gitignore`，**不會隨 repo 提交**，需自行建立。

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)，建立（或選擇）一個專案
2. 啟用 **Google Drive API**
3. 建立憑證 → **OAuth 2.0 用戶端 ID**，應用程式類型選「**桌面應用程式**」
4. 下載憑證 JSON，重新命名為 `credentials.json`，放入 `media/` 資料夾

> 若不需要 Google Drive 功能，可略過此步驟，擴充套件的本機閱讀功能仍可正常使用。

### 3. 編譯

```batch
npm run compile
```

監看模式（修改時自動重新編譯）：

```batch
npm run watch
```

### 4. 打包成 `.vsix`

```batch
pack.bat
```

輸出檔案位於 `release/` 資料夾。

---

## 授權

MIT License
