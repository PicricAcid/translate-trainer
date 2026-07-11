import { useRef, useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

export type BlockType = "en" | "ja";

export interface HighlightRange {
    start: number;
    end: number;
    vocab_id: number;
}

export interface Block {
    id: number;
    block_type: BlockType;
    content: string;
    highlights: HighlightRange[];
}

export interface VocabEntry {
    id: number;
    word: string;
    meaning: string;
    block_id: number;
}

export interface Document {
    title: string;
    blocks: Block[];
    focus_block_id: number | null;
    vocab: VocabEntry[];
}

function HighlightedText({ block }: { block: Block }) {
    const { content, highlights } = block;

    if (highlights.length === 0) {
        return <span className="rendered-text">{content}</span>;
    }

    const sorted = [...highlights].sort((a, b) => a.start - b.start);
    const segments: { text: string; highlighted: boolean }[] = [];
    let cursor = 0;

    for (const h of sorted) {
        if (h.start > cursor) {
            segments.push({ text: content.slice(cursor, h.start), highlighted: false });
        }
        segments.push({ text: content.slice(h.start, h.end), highlighted: true });
        cursor = h.end;
    }

    if (cursor < content.length) {
        segments.push({ text: content.slice(cursor), highlighted: false });
    }

    return (
        <span className="rendered-text">
            {segments.map((seg, i) =>
                seg.highlighted ? (
                    <mark key={i} className="highlight-mark">{seg.text}</mark>
                ) : (
                    <span key={i}>{seg.text}</span>
                )
            )}
        </span>
    );
}

function BlockTextarea({
    block,
    onChange,
    onCommit,
    onSplit,
    registerRef,
    onHighlight,
}: {
    block: Block;
    onChange: (id: number, content: string) => void;
    onCommit: (id: number, content: string) => Promise<void>;
    onSplit: (id: number, pos: number, before: string, after: string) => Promise<void>;
    registerRef: (id: number, el: HTMLTextAreaElement | null) => void;
    onHighlight: (id: number, start: number, end: number) => Promise<void>;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);

    const resize = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, []);

    const [isEditing, setIsEditing] = useState(false);

    useEffect(() => {
        if (isEditing) resize();
    }, [block.content, isEditing, resize]);

    useEffect(() => {
        registerRef(block.id, ref.current);
        return () => registerRef(block.id, null);
    }, [block.id]);

  // カーソル位置でテキストを分割してonSplitを呼ぶ
    function handleSplitClick() {
        const ta = ref.current;
        if (!ta) return;
        const pos = ta.selectionStart;

        const rawAfter = ta.value.slice(pos);
        const before = ta.value.slice(0, pos).trimEnd();
        const after = rawAfter.trimStart();

        // posのままだと改行丸めなどで文字列が変わるため、丸め前の位置を返す
        const afterpos = pos + (rawAfter.length - after.length);
        onSplit(block.id, afterpos, before, after);
    }

    async function handleHighlightClick() {
        const ta = ref.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start === end) return;

        // contentをcommitしてからハイライト追加
        await onCommit(block.id, ta.value);
        onHighlight(block.id, start, end);

        // ハイライト登録後focusを外す(focus状態だとハイライトが反映されない)
        setIsEditing(false);
        ta.blur();
    }

    return (
        <div className="block-row">
            {isEditing ? (
                <textarea
                    ref={ref}
                    className={`block-textarea ${block.block_type}`}
                    value={block.content}
                    placeholder={
                        block.block_type === "en" ? "English..." : "日本語訳を入力してください..."
                    }
                    rows={1}
                    onChange={(e) => {
                        onChange(block.id, e.target.value);
                        resize();
                    }}
                    autoFocus
                    onBlur={(e) => {
                        onCommit(block.id, e.target.value);
                        setIsEditing(false);
                    }}
                />
            ) : (
                <div 
                    className={`block-rendered ${block.block_type}`}
                    tabIndex={0}
                    onFocus={() => setIsEditing(true)}
                    onClick={() => {
                        setIsEditing(true);
                        requestAnimationFrame(() => ref.current?.focus());
                    }}
                >
                    {block.content.length === 0 ? (
                        <span className="rendered-placeholder">...</span>
                    ) : (
                        <HighlightedText block={block} />
                    )}
                </div>
            )}

            <div
                className="block-actions"
                style={{ visibility: isEditing ? "visible" : "hidden" }}
            >
                <button 
                    className="split-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleHighlightClick}
                >
                    ✎
                </button>
                <button
                    className="split-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleSplitClick}
                >
                    ＋
                </button>
            </div>
        </div>
    );
}

function Toolbar({
    title,
    onTitleChange,
    onTitleCommit,
    onOpen,
    onSave,
}: {
    title: string;
    onTitleChange: (title: string) => void;
    onTitleCommit: (title: string) => Promise<void>;
    onOpen: () => void;
    onSave: () => void;
}) {
    return (
        <header className="toolbar">
            <input className="toolbar-title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                onBlur={(e) => onTitleCommit(e.target.value)}
            />
            <button className="tb-btn" onClick={onOpen}>開く</button>
            <button className="tb-btn" onClick={onSave}>保存</button>
        </header>
    );
}

function Sidebar({ 
    enCount,
    jaCount,
    vocab,
    onUpdateMeaning,
}: {
    enCount: number;
    jaCount: number;
    vocab: VocabEntry[];
    onUpdateMeaning: (id: number, meaning: string) => Promise<void>;
}) {
    return (
        <aside className="sidebar">
            <section className="sidebar-section">
                <h2 className="sidebar-label">進捗</h2>
                <div className="stat-row">
                    <span>段落数</span>
                    <span className="stat-val">{enCount}</span>
                </div>
                <div className="stat-row">
                    <span>訳済み</span>
                    <span className="stat-val">
                        {jaCount} / {enCount}
                    </span>
                </div>
            </section>

            <hr className="sidebar-divider" />

            <section className="sidebar-section">
                <h2 className="sidebar-label">単語帳 ({vocab.length})</h2>
                <div className="vocab-list">
                    {vocab.length === 0 && <p className="vocab-empty">...</p>}
                    {vocab.map((v) => (
                        <div key={v.id} className="vocab-item">
                            <div className="vocab-word">{v.word}</div>
                            <input
                                className="vocab-meaning"
                                defaultValue={v.meaning}
                                onBlur={(e) => onUpdateMeaning(v.id, e.target.value)}
                            />
                        </div>
                    ))}
                </div>
            </section>
        </aside>
    );
}


function App() {
    const [document, setDocument] = useState<Document>({ 
        title: "",
        blocks: [],
        focus_block_id: null,
        vocab: [],
    });
    const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());

    useEffect(() => {
        invoke<Document>("get_document").then(setDocument);
    }, []);

    useEffect(() => {
        if (document.focus_block_id === null) return;
        const id = document.focus_block_id;
        requestAnimationFrame(() => {
            textareaRefs.current.get(id)?.focus();
        });
    }, [document.focus_block_id]);

    function registerRef(id: number, el: HTMLTextAreaElement | null) {
        if (el) textareaRefs.current.set(id, el);
        else textareaRefs.current.delete(id);
    }

    function updateContent(id: number, content: string) {
        setDocument((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => (b.id === id ? { ...b, content } : b)),
        }));
    }

    async function commitContent(id: number, content: string) {
        const result = await invoke<Document>("update_block", { id, content });
        setDocument(result);
    }

    async function splitBlock(id: number, pos: number, before: string, after: string) {
        const result = await invoke<Document>("insert_block", { id, pos, before, after });
        setDocument(result);
    }

    async function handleOpen() {
        const result = await invoke<Document>("open_document");
        setDocument(result);
    }

    async function handleSave() {
        await invoke("save_document");
    }

    async function highlightSelection(id: number, start: number, end: number) {
        const result = await invoke<Document>("add_highlight", { blockId: id, start, end });
        setDocument(result);
    }

    async function updateVocabMeaning(id: number, meaning: string) {
        const result = await invoke<Document>("update_vocab_meaning", { id, meaning });
        setDocument(result);
    }

    function updateTitle(title: string) {
        setDocument((prev) => ({ ...prev, title }));
    }

    async function commitTitle(title: string) {
        const result = await invoke<Document>("update_title", { title });
        setDocument(result);
    }

    const enCount = document.blocks.filter((b) => b.block_type === "en").length;
    const jaCount = document.blocks.filter((b) => b.block_type === "ja").length;

    return (
        <div className="app">
            <Toolbar 
                title={document.title}
                onTitleChange={updateTitle}
                onTitleCommit={commitTitle}
                onOpen={handleOpen}
                onSave={handleSave}
            />
            <div className="main">
                <div className="editor">
                    {document.blocks.map((block, i) => {
                        const next = document.blocks[i + 1];
                        const showSeparator =
                            block.block_type === "en" && next?.block_type === "en";

                        return (
                            <div key={block.id}>
                                <BlockTextarea
                                    block={block}
                                    onChange={updateContent}
                                    onCommit={commitContent}
                                    onSplit={splitBlock}
                                    registerRef={registerRef}
                                    onHighlight={highlightSelection}
                                />
                                {showSeparator && <hr className="separator" />}
                            </div>
                        );
                    })}
                </div>
                <Sidebar
                    enCount={enCount}
                    jaCount={jaCount}
                    vocab={document.vocab}
                    onUpdateMeaning={updateVocabMeaning}
                />
           </div>
        </div>
    );
}

export default App;
