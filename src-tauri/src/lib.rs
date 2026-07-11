use serde::{Serialize, Deserialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::sync::mpsc;
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use std::fs;
use serde_json;

static NEXT_BLOCK_ID: AtomicU32 = AtomicU32::new(1);
static NEXT_VOCAB_ID: AtomicU32 = AtomicU32::new(1);

fn next_block_id() -> u32 {
    NEXT_BLOCK_ID.fetch_add(1, Ordering::Relaxed)
}

fn next_vocab_id() -> u32 {
    NEXT_VOCAB_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct VocabEntry {
    id: u32,
    word: String,
    meaning: String,
    block_id: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum BlockType {
    En,
    Ja,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Document {
    title: String,
    blocks: Vec<Block>,
    focus_block_id: Option<u32>,
    vocab: Vec<VocabEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Block {
    id: u32,
    block_type: BlockType,
    content: String,
    highlights: Vec<HighlightRange>,
}

struct AppState {
    document: Mutex<Document>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct HighlightRange {
    start: u32,
    end: u32,
    vocab_id: u32,
}

#[tauri::command]
fn get_document(state: State<AppState>) -> Result<Document, String> {
    let doc = state.document.lock().map_err(|e| e.to_string())?;
    Ok(doc.clone())
}

#[tauri::command]
fn insert_block(id: u32, pos: u32, before: String, after: String, state: State<AppState>) -> Result<Document, String> {
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;

    // idのblockのblocksの中での位置
    let idx = doc.blocks.iter().position(|b| b.id == id)
        .ok_or("block not found")?;

    // 分割位置を算出(= beforeの文字数)
    let split_pos = pos;

    // highlightも分割前後に振り分ける
    let mut before_highlights = vec![];
    let mut after_highlights = vec![];

    for h in doc.blocks[idx].highlights.drain(..) {
        if h.end <= split_pos {
            // before範囲に収まる場合
            before_highlights.push(h);
        } else if h.start >= split_pos {
            // after範囲に収まる場合
            after_highlights.push(HighlightRange {
                start: h.start - split_pos,
                end: h.end - split_pos,
                vocab_id: h.vocab_id,
            });
        } else {
            // 分割位置をまたがるハイライトは破棄する
        }
    }
        
    // 分割元のblockにはbeforeを上書き
    doc.blocks[idx].content = before;

    doc.blocks[idx].highlights = before_highlights;
    
    let new_block_type: BlockType = 
        if doc.blocks[idx].block_type == BlockType::En {
            BlockType::Ja
        } else {
            BlockType::En
        };

    let new_block_id: u32 = next_block_id();
    
    let new_block: Block = Block {
        id: new_block_id,
        block_type: new_block_type,
        content: String::new(),
        highlights: vec![],
    };
    
    // insert用vector... [new_block, after_block]
    let mut to_insert = vec![new_block];
    // afterは存在しない場合がある
    if !after.is_empty() {
        to_insert.push(Block {
            id: next_block_id(),
            block_type: doc.blocks[idx].block_type,
            content: after,
            highlights: after_highlights,
        });
    }

    // to_insertをidx + 1(beforeの後ろ)にまとめてinsert
    doc.blocks.splice(idx + 1..idx + 1, to_insert);

    // focusは新しいblockに
    doc.focus_block_id = Some(new_block_id);
    
    Ok(doc.clone())
}

#[tauri::command]
fn update_block(id: u32, content: String, state: State<AppState>) -> Result<Document, String> {
    // Documentのロック取得
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;

    let idx = doc.blocks.iter().position(|b| b.id == id)
        .ok_or("block not found")?;

    doc.blocks[idx].content = content;
    doc.focus_block_id = None;

    Ok(doc.clone())
}

#[tauri::command]
async fn open_document(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Document, String> {
    let (tx, rx) = mpsc::channel();

    app.dialog()
        .file()
        .add_filter("Text or JSON", &["txt", "json"])
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.recv().map_err(|e| e.to_string())?
        .ok_or("file selection cancelled")?;

    let path: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;

    let ext = path.extension().and_then(|e| e.to_str());
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // Documentのロック取得
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;

    match ext {
        Some("txt") => {
            // 新規テキストではidを1から振り直し
            NEXT_BLOCK_ID.store(1, Ordering::Relaxed);

            let title = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("nontitle")
                .to_string();

            let new_block = Block {
                id: next_block_id(),
                block_type: BlockType::En,
                content: content,
                highlights: vec![],
            };

            doc.blocks = vec![new_block];
            doc.focus_block_id = None;
            doc.title = title;
        }
        Some("json") => {
            let new_doc: Document = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            
            // 読み込んだjsonの最大idの続きから採番
            let max_id = new_doc.blocks.iter().map(|b| b.id).max().unwrap_or(0);
            NEXT_BLOCK_ID.store(max_id + 1, Ordering::Relaxed);
        
            *doc = new_doc;
        }
        _ => return Err("unsupported file type".to_string()),
    }

    Ok(doc.clone())
}

#[tauri::command]
async fn save_document(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();

    // Documentのロック取得
    let doc = state.document.lock().map_err(|e| e.to_string())?;

    let default_name = format!("{}.json", doc.title);

    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&default_name)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.recv().map_err(|e| e.to_string())?
        .ok_or("save cancelled")?;
    
    let path: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let json_doc = serde_json::to_string(&(*doc)).map_err(|e| e.to_string())?;
    
    fs::write(&path, json_doc).map_err(|e| e.to_string())?;

    Ok(()) 
}

fn extract_word(content: &str, start: u32, end: u32) -> Result<String, String> {
    let chars: Vec<char> = content.chars().collect();
    let start = start as usize;
    let end = end as usize;
    
    if start > end || end > chars.len() {
        return Err("invalid highlight range".to_string());
    }

    Ok(chars[start..end].iter().collect())
}

#[tauri::command]
fn add_highlight(block_id: u32, start: u32, end: u32, state: State<AppState>) -> Result<Document, String> {
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;

    let idx = doc.blocks.iter().position(|b| b.id == block_id)
        .ok_or("block not found")?;

    let word = extract_word(&doc.blocks[idx].content, start, end)?;

    let vocab_id = next_vocab_id();

    doc.blocks[idx].highlights.push(HighlightRange {
        start,
        end,
        vocab_id,
    });

    doc.vocab.push(VocabEntry {
        id: vocab_id,
        word: word,
        meaning: String::new(),
        block_id: block_id,
    });

    println!(
        "block {} highlights: {:?}",
        block_id,
        doc.blocks[idx].highlights
    );

    Ok(doc.clone()) 
}

#[tauri::command]
fn update_vocab_meaning(id: u32, meaning: String, state: State<AppState>) -> Result<Document, String> {
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;

    let idx = doc.vocab.iter().position(|b| b.id == id)
        .ok_or("vocab not found")?;

    doc.vocab[idx].meaning = meaning;

    Ok(doc.clone())
}

#[tauri::command]
fn update_title(title: String, state: State<AppState>) -> Result<Document, String> {
    // Documentのロックを取得
    let mut doc = state.document.lock().map_err(|e| e.to_string())?;
    doc.title = title;
    Ok(doc.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            document: Mutex::new(Document {
                title: "nontitle".to_string(),
                blocks: vec![
                    Block {
                        id: next_block_id(),
                        block_type: BlockType::En,
                        content: "In my younger and more vulnerable years my father gave me some advice that I've been turning over in my mind ever since.\nHe didn't say any more, but we've always been unusually communicative in a reserved way, and I understood that he meant a great deal more than that.\nI graduated from New Haven in 1915, just a quarter of a century after my father, and a little later I participated in that delayed Teutonic migration known as the Great War.".to_string(),
                        highlights: vec![],
                    },
                ], 
                focus_block_id: None,
                vocab: vec![],
            }),
        })
        .invoke_handler(tauri::generate_handler![
            get_document,
            insert_block,
            update_block,
            open_document,
            save_document,
            add_highlight,
            update_vocab_meaning,
            update_title,
        ])
        .run(tauri::generate_context!())
        .expect("Error!")
}
