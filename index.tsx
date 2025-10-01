/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import loader from '@monaco-editor/loader';
import markdownit from 'markdown-it';
import {sanitizeHtml} from 'safevalues';
import {setAnchorHref, setElementInnerHtml, windowOpen} from 'safevalues/dom';
import Sortable, {SortableEvent} from 'sortablejs';

interface MarkdownItInstance {
  render: (markdown: string) => string;
}

// Monaco will be loaded dynamically
// Fix: Use Awaited<ReturnType<...>> to infer the monaco type from the loader,
// which avoids a circular type reference and preserves type safety.
type Monaco = Awaited<ReturnType<typeof loader.init>>;
// tslint:disable-next-line:no-any - we need to load the library first.
let monaco: Monaco | undefined;
// tslint:disable-next-line:no-any - we need to load the library first.
// Fix: Infer the editor instance type from the return type of the `create` method.
type MonacoEditorInstance = ReturnType<Monaco['editor']['create']>;
interface AppMetadata {
  name?: string;
  title?: string;
}

const metadataResponse = await fetch('metadata.json');
const appMetadata: AppMetadata = (await metadataResponse.json()) as AppMetadata;

interface CookbookData {
  notebookCode: string;
}

const cookbookResponse = await fetch('cookbook.json');
const cookbookMetadata: CookbookData =
  (await cookbookResponse.json()) as CookbookData;

function blobToRaw(blobUrl: string) {
  const pattern =
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/;
  const match = blobUrl.match(pattern);

  if (!match) {
    throw new Error('Invalid GitHub blob URL');
  }

  const [, repo, branch, path] = match;
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

const rawUrl = blobToRaw(cookbookMetadata.notebookCode);
const codeResponse = await fetch(rawUrl);
const code = await codeResponse.text();

type CellType = 'javascript' | 'markdown';

interface Cell {
  id: string;
  type: CellType;
  content: string;
  editor?: MonacoEditorInstance;
  output?: string;
  outputElement?: HTMLElement;
  isExecuting?: boolean;
  isRendered?: boolean;
}

let cells: Cell[] = [];
let activeCell: Cell | null = null;
let clipboard: Cell | null = null;
let sortable: Sortable | null = null;
let isLineNumbersVisible = true;
let notebookEl: HTMLElement | null = null;
const cellInserter = createCellInserter();

const md: MarkdownItInstance = markdownit({html: true});

function createCell(type: CellType, content = '', id?: string): Cell {
  return {
    id: id || `cell-${Date.now()}-${Math.random()}`,
    type,
    content,
  };
}

function renderCell(cell: Cell, container: HTMLElement, index: number) {
  const cellEl = document.createElement('div');
  cellEl.id = cell.id;
  cellEl.className = 'cell';
  cellEl.dataset.type = cell.type;

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
  cellEl.appendChild(dragHandle);

  const executionStatus = document.createElement('div');
  executionStatus.className = 'execution-status';
  executionStatus.innerHTML = '<i class="fa-solid fa-check"></i>';
  cellEl.appendChild(executionStatus);

  if (cell.type === 'javascript') {
    renderCodeCell(cell, cellEl);
  } else {
    renderMarkdownCell(cell, cellEl);
  }

  createCellHoverMenu(cell, cellEl);
  container.appendChild(cellEl);

  cellEl.addEventListener('click', () => {
    setActiveCell(cell);
  });
}

function renderCodeCell(cell: Cell, cellEl: HTMLElement) {
  const editorContainer = document.createElement('div');
  editorContainer.className = 'editor-container';
  cellEl.appendChild(editorContainer);

  const outputEl = document.createElement('pre');
  outputEl.className = 'output';
  outputEl.style.display = 'none';
  cellEl.appendChild(outputEl);
  cell.outputElement = outputEl;

  if (monaco) {
    const editor = monaco.editor.create(editorContainer, {
      value: cell.content,
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: {enabled: false},
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      lineNumbers: isLineNumbersVisible ? 'on' : 'off',
      contextmenu: true,
      fontSize: 14,
    });

    editor.onDidContentSizeChange(() => {
      const contentHeight = editor.getContentHeight();
      editorContainer.style.height = `${Math.max(40, contentHeight)}px`;
    });

    cell.editor = editor;
  }
}

function renderMarkdownCell(cell: Cell, cellEl: HTMLElement) {
  cell.isRendered = true;
  cellEl.classList.add('rendered-md');

  const outputEl = document.createElement('div');
  outputEl.className = 'output';
  setElementInnerHtml(outputEl, sanitizeHtml(md.render(cell.content)));
  cellEl.appendChild(outputEl);
  cell.outputElement = outputEl;

  cellEl.addEventListener('dblclick', () => {
    startEditingMarkdown(cell, cellEl);
  });
}

function startEditingMarkdown(cell: Cell, cellEl: HTMLElement) {
  cell.isRendered = false;
  cellEl.classList.remove('rendered-md');
  if (cell.outputElement) {
    cell.outputElement.style.display = 'none';
  }

  const editorContainer = document.createElement('div');
  editorContainer.className = 'editor-container';
  // Insert before the output element if it exists
  cellEl.insertBefore(editorContainer, cellEl.querySelector('.output'));

  if (monaco) {
    const editor = monaco.editor.create(editorContainer, {
      value: cell.content,
      language: 'markdown',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: {enabled: false},
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      lineNumbers: 'off',
      contextmenu: true,
      fontSize: 14,
    });

    editor.onDidContentSizeChange(() => {
      const contentHeight = editor.getContentHeight();
      editorContainer.style.height = `${Math.max(40, contentHeight)}px`;
    });

    cell.editor = editor;

    const finishEditing = () => {
      if (cell.editor) {
        cell.content = cell.editor.getValue();
        cell.editor.dispose();
        cell.editor = undefined;
        editorContainer.remove();
        cell.isRendered = true;
        cellEl.classList.add('rendered-md');
        if (cell.outputElement) {
          cell.outputElement.style.display = 'block';
          setElementInnerHtml(
            cell.outputElement,
            sanitizeHtml(md.render(cell.content)),
          );
        }
      }
    };

    editor.onDidBlurEditorWidget(finishEditing);
    // Add a button or other mechanism to finish editing
    // For simplicity, we'll rely on blur for now.
  }
}

function createCellHoverMenu(cell: Cell, cellEl: HTMLElement) {
  const menu = document.createElement('div');
  menu.className = 'cell-hover-menu';

  const runButton = document.createElement('button');
  runButton.title = 'Run cell (Ctrl+Enter)';
  runButton.innerHTML = '<i class="fa-solid fa-play"></i>';
  runButton.onclick = (e) => {
    e.stopPropagation();
    runCell(cell);
  };

  const deleteButton = document.createElement('button');
  deleteButton.title = 'Delete cell';
  deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
  deleteButton.onclick = (e) => {
    e.stopPropagation();
    deleteCell(cell.id);
  };

  if (cell.type === 'javascript') {
    menu.appendChild(runButton);
  }
  menu.appendChild(deleteButton);
  cellEl.appendChild(menu);
}

function setActiveCell(cell: Cell | null) {
  if (activeCell?.id === cell?.id) return;

  const oldActive = activeCell ? document.getElementById(activeCell.id) : null;
  if (oldActive) {
    oldActive.classList.remove('active');
  }

  activeCell = cell;

  if (activeCell) {
    const newActive = document.getElementById(activeCell.id);
    if (newActive) {
      newActive.classList.add('active');
    }
  }
}

function addCell(type: CellType, content = '', index: number) {
  const newCell = createCell(type, content);
  cells.splice(index, 0, newCell);
  renderNotebook();
  setActiveCell(newCell);
  if (newCell.editor) {
    newCell.editor.focus();
  }
}

function deleteCell(id: string) {
  const index = cells.findIndex((c) => c.id === id);
  if (index > -1) {
    const cell = cells[index];
    if (cell.editor) {
      cell.editor.dispose();
    }
    cells.splice(index, 1);
    if (activeCell?.id === id) {
      const newActiveIndex = Math.max(0, index - 1);
      setActiveCell(cells.length > 0 ? cells[newActiveIndex] : null);
    }
    renderNotebook();
  }
}

async function runCell(cell: Cell) {
  if (cell.type !== 'javascript' || cell.isExecuting) return;

  const outputEl = cell.outputElement;
  if (!outputEl) return;

  cell.isExecuting = true;
  outputEl.innerHTML = '';
  outputEl.style.display = 'block';

  const cellEl = document.getElementById(cell.id);
  if (cellEl) {
    cellEl.classList.add('executing');
    cellEl.classList.remove('executed');
  }

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalTrace = console.trace;

  const createLogHandler = (type: string) => {
    return (...args: unknown[]) => {
      const message = args
        .map((arg) => {
          if (arg instanceof HTMLElement) {
            return arg.outerHTML;
          }
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        })
        .join(' ');
      const logEntry = document.createElement('div');
      logEntry.className = `console-${type}`;
      logEntry.textContent = message;
      outputEl.appendChild(logEntry);
      originalLog.apply(console, args); // Also log to the browser console
    };
  };

  console.log = createLogHandler('log');
  console.error = createLogHandler('error');
  console.warn = createLogHandler('warn');
  console.info = createLogHandler('info');
  console.debug = createLogHandler('debug');
  console.trace = createLogHandler('trace');

  try {
    const codeToRun = cell.editor ? cell.editor.getValue() : cell.content;
    const asyncFunction = new Function(
      'return (async () => {' + codeToRun + '})()',
    );
    const result = await asyncFunction();
    if (result !== undefined) {
      const resultEntry = document.createElement('div');
      resultEntry.className = 'console-result';
      const resultArrow = document.createElement('span');
      resultArrow.textContent = '↳ ';
      resultEntry.appendChild(resultArrow);
      const resultText = document.createElement('span');
      resultText.textContent = JSON.stringify(result, null, 2);
      resultEntry.appendChild(resultText);
      outputEl.appendChild(resultEntry);
    }
  } catch (e) {
    const error = e as Error;
    console.error(error.message);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    console.debug = originalDebug;
    console.trace = originalTrace;

    cell.isExecuting = false;
    if (cellEl) {
      cellEl.classList.remove('executing');
      cellEl.classList.add('executed');
    }
    renderOutputs(outputEl);
  }
}

async function runAllCells() {
  for (const cell of cells) {
    if (cell.type === 'javascript') {
      await runCell(cell);
    }
  }
}

function renderOutputs(outputEl: HTMLElement) {
  // Convert image data URIs to img elements
  const images =
    outputEl.innerHTML.match(
      /data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)/g,
    ) || [];
  if (images.length > 0) {
    outputEl.innerHTML = ''; // Clear the text-based data URLs
    images.forEach((imageDataUrl) => {
      const img = document.createElement('img');
      img.src = imageDataUrl;
      img.style.maxWidth = '100%';
      img.style.cursor = 'pointer';
      outputEl.appendChild(img);
    });
  }

  // Make all images in the output clickable for the lightbox
  const outputImages = outputEl.querySelectorAll('img');
  const imageUrls = Array.from(outputImages).map((img) => img.src);

  outputImages.forEach((img, index) => {
    img.addEventListener('click', () => {
      openLightbox(imageUrls, index);
    });
  });
}

function renderNotebook() {
  if (notebookEl) {
    notebookEl.innerHTML = '';
    cells.forEach((cell, index) => {
      renderCell(cell, notebookEl, index);
    });
  }
  updateCellInserter();
}

function createCellInserter() {
  const el = document.createElement('div');
  el.id = 'cell-inserter';
  el.style.display = 'none';

  const line = document.createElement('div');
  line.className = 'inserter-line';

  const buttons = document.createElement('div');
  buttons.className = 'inserter-buttons';

  const addCodeBtn = document.createElement('button');
  addCodeBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Code';
  addCodeBtn.onclick = () => {
    const index = parseInt(el.dataset.index || '0', 10);
    addCell('javascript', '', index);
    el.style.display = 'none';
  };

  const addMDBtn = document.createElement('button');
  addMDBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Markdown';
  addMDBtn.onclick = () => {
    const index = parseInt(el.dataset.index || '0', 10);
    addCell('markdown', '', index);
    el.style.display = 'none';
  };

  buttons.appendChild(addCodeBtn);
  buttons.appendChild(addMDBtn);

  el.appendChild(line.cloneNode());
  el.appendChild(buttons);
  el.appendChild(line.cloneNode());

  return el;
}

function updateCellInserter() {
  const notebook = document.getElementById('notebook');
  if (!notebook) return;

  notebook.addEventListener('mousemove', (e) => {
    const cellsEls = Array.from(
      notebook.querySelectorAll('.cell'),
    ) as HTMLElement[];
    let bestMatch: {el: HTMLElement; index: number} | null = null;

    for (let i = 0; i < cellsEls.length; i++) {
      const el = cellsEls[i];
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (e.clientY < midY) {
        bestMatch = {el, index: i};
        break;
      }
    }
    // For the space after the last cell
    if (!bestMatch && cellsEls.length > 0) {
      const lastCell = cellsEls[cellsEls.length - 1];
      const rect = lastCell.getBoundingClientRect();
      if (e.clientY > rect.bottom) {
        bestMatch = {el: lastCell, index: cellsEls.length};
      }
    } else if (cellsEls.length === 0) {
      // For empty notebook
      cellInserter.style.top = '20px';
      cellInserter.style.display = 'flex';
      cellInserter.dataset.index = '0';
      return;
    }

    if (bestMatch) {
      const {el, index} = bestMatch;
      const rect = el.getBoundingClientRect();
      const top = index === 0 ? rect.top : rect.top - rect.height / 2;
      const offset =
        index === 0 ? -10 : index === cells.length ? rect.height + 10 : 0;
      cellInserter.style.top = `${el.offsetTop + offset}px`;
      cellInserter.style.display = 'flex';
      cellInserter.dataset.index = `${index}`;
    } else {
      cellInserter.style.display = 'none';
    }
  });

  notebook.addEventListener('mouseleave', () => {
    cellInserter.style.display = 'none';
  });
}

function initSortable() {
  if (sortable) {
    sortable.destroy();
  }
  if (notebookEl) {
    sortable = new Sortable(notebookEl, {
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: (evt: SortableEvent) => {
        if (evt.oldIndex !== undefined && evt.newIndex !== undefined) {
          const [movedCell] = cells.splice(evt.oldIndex, 1);
          cells.splice(evt.newIndex, 0, movedCell);
          // Re-render is not ideal, but simplest for now
          renderNotebook();
        }
      },
    });
  }
}

function setupEventListeners() {
  document.getElementById('run-all-btn')?.addEventListener('click', runAllCells);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      if (activeCell) {
        runCell(activeCell);
      }
    }
  });

  document.getElementById('new-btn')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to start a new notebook?')) {
      cells = [
        createCell('markdown', '# New Notebook'),
        createCell('javascript', "console.log('Hello, World!');"),
      ];
      renderNotebook();
    }
  });

  document.getElementById('download-btn')?.addEventListener('click', () => {
    const jsCode = cells
      .filter((c) => c.type === 'javascript')
      .map((c) => (c.editor ? c.editor.getValue() : c.content))
      .join('\n\n// ---- New Cell ----\n\n');
    const blob = new Blob([jsCode], {type: 'application/javascript'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'notebook.js';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('github-btn')?.addEventListener('click', () => {
    windowOpen(cookbookMetadata.notebookCode);
  });

  document.getElementById('cut-cell-btn')?.addEventListener('click', () => {
    if (activeCell) {
      clipboard = {...activeCell};
      if (activeCell.editor) {
        clipboard.content = activeCell.editor.getValue();
      }
      deleteCell(activeCell.id);
    }
  });

  document.getElementById('copy-cell-btn')?.addEventListener('click', () => {
    if (activeCell) {
      clipboard = {...activeCell};
      if (activeCell.editor) {
        clipboard.content = activeCell.editor.getValue();
      }
    }
  });

  document.getElementById('paste-cell-btn')?.addEventListener('click', () => {
    if (clipboard) {
      const activeIndex = activeCell
        ? cells.findIndex((c) => c.id === activeCell.id)
        : cells.length - 1;
      addCell(clipboard.type, clipboard.content, activeIndex + 1);
    }
  });

  document.getElementById('toggle-line-numbers-btn')?.addEventListener('click', () => {
    isLineNumbersVisible = !isLineNumbersVisible;
    cells.forEach(cell => {
      if (cell.editor) {
        cell.editor.updateOptions({ lineNumbers: isLineNumbersVisible ? 'on' : 'off' });
      }
    });
  });

  const insertCodeBtn = document.getElementById('insert-code-btn');
  if (insertCodeBtn) {
    insertCodeBtn.addEventListener('click', () => {
      const index = activeCell ? cells.indexOf(activeCell) + 1 : cells.length;
      addCell('javascript', '', index);
    });
  }

  const insertMdBtn = document.getElementById('insert-md-btn');
  if (insertMdBtn) {
    insertMdBtn.addEventListener('click', () => {
      const index = activeCell ? cells.indexOf(activeCell) + 1 : cells.length;
      addCell('markdown', '', index);
    });
  }
}

// Lightbox functionality
let lightboxImages: string[] = [];
let currentImageIndex = 0;
let zoom = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;

function createLightbox() {
  const overlay = document.createElement('div');
  overlay.id = 'lightbox-overlay';

  const content = document.createElement('div');
  content.id = 'lightbox-content';
  const image = document.createElement('img');
  image.id = 'lightbox-image';
  content.appendChild(image);

  const closeBtn = document.createElement('span');
  closeBtn.id = 'lightbox-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = closeLightbox;

  const prevBtn = document.createElement('button');
  prevBtn.id = 'lightbox-prev';
  prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
  prevBtn.onclick = (e) => {
    e.stopPropagation();
    showPrevImage();
  };

  const nextBtn = document.createElement('button');
  nextBtn.id = 'lightbox-next';
  nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
  nextBtn.onclick = (e) => {
    e.stopPropagation();
    showNextImage();
  };

  const controls = document.createElement('div');
  controls.id = 'lightbox-controls';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.innerHTML = '<i class="fa-solid fa-search-plus"></i>';
  zoomInBtn.onclick = (e) => {
    e.stopPropagation();
    updateZoom(0.2);
  };

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '<i class="fa-solid fa-search-minus"></i>';
  zoomOutBtn.onclick = (e) => {
    e.stopPropagation();
    updateZoom(-0.2);
  };
  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
  resetBtn.onclick = (e) => {
    e.stopPropagation();
    resetZoomAndPan();
  };

  controls.appendChild(zoomInBtn);
  controls.appendChild(zoomOutBtn);
  controls.appendChild(resetBtn);

  overlay.appendChild(closeBtn);
  overlay.appendChild(prevBtn);
  overlay.appendChild(nextBtn);
  overlay.appendChild(content);
  overlay.appendChild(controls);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeLightbox();
    }
  });

  image.addEventListener('wheel', (e) => {
    e.preventDefault();
    updateZoom(-e.deltaY * 0.001);
  });

  image.addEventListener('mousedown', (e) => {
    if (zoom > 1) {
      isPanning = true;
      image.style.cursor = 'grabbing';
      startPanX = e.clientX - panX;
      startPanY = e.clientY - panY;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      panX = e.clientX - startPanX;
      panY = e.clientY - startPanY;
      applyTransform();
    }
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    if (zoom > 1) {
      image.style.cursor = 'grab';
    } else {
      image.style.cursor = 'default';
    }
  });

  window.addEventListener('keydown', (e) => {
    if (overlay.style.display === 'flex') {
      if (e.key === 'ArrowRight') showNextImage();
      if (e.key === 'ArrowLeft') showPrevImage();
      if (e.key === 'Escape') closeLightbox();
    }
  });
}

function openLightbox(images: string[], index: number) {
  const overlay = document.getElementById('lightbox-overlay') as HTMLElement;
  lightboxImages = images;
  currentImageIndex = index;
  updateLightboxImage();
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const overlay = document.getElementById('lightbox-overlay') as HTMLElement;
  overlay.style.display = 'none';
  document.body.style.overflow = 'auto';
  resetZoomAndPan();
}

function updateLightboxImage() {
  const image = document.getElementById('lightbox-image') as HTMLImageElement;
  const prevBtn = document.getElementById('lightbox-prev') as HTMLElement;
  const nextBtn = document.getElementById('lightbox-next') as HTMLElement;

  if (image) {
    image.src = lightboxImages[currentImageIndex];
    resetZoomAndPan();
  }
  if (prevBtn && nextBtn) {
    prevBtn.style.display = lightboxImages.length > 1 ? 'flex' : 'none';
    nextBtn.style.display = lightboxImages.length > 1 ? 'flex' : 'none';
  }
}

function showNextImage() {
  if (lightboxImages.length > 1) {
    currentImageIndex = (currentImageIndex + 1) % lightboxImages.length;
    updateLightboxImage();
  }
}

function showPrevImage() {
  if (lightboxImages.length > 1) {
    currentImageIndex =
      (currentImageIndex - 1 + lightboxImages.length) % lightboxImages.length;
    updateLightboxImage();
  }
}

function updateZoom(amount: number) {
  zoom = Math.max(1, zoom + amount);
  applyTransform();
}

function resetZoomAndPan() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  const image = document.getElementById('lightbox-image') as HTMLImageElement;
  if (image) {
    image.style.cursor = 'default';
  }
}

function applyTransform() {
  const image = document.getElementById('lightbox-image') as HTMLImageElement;
  if (image) {
    image.style.transform = `scale(${zoom}) translate(${panX / zoom}px, ${
      panY / zoom
    }px)`;
  }
}

async function main() {
  if (appMetadata.title) {
    document.title = appMetadata.title;
    const titleEl = document.getElementById('notebook-title');
    if (titleEl) {
      titleEl.textContent = appMetadata.title;
    }
  }

  monaco = await loader.init();

  // Fix: Rename theme to avoid potential conflicts with built-in themes.
  monaco.editor.defineTheme('cookbook-theme', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      {token: 'comment', foreground: '6A9955'},
      {token: 'string', foreground: 'CE9178'},
      // ... add more rules for a richer theme if desired
    ],
    colors: {
      'editor.background': '#1E1E1E',
    },
  });
  monaco.editor.setTheme('cookbook-theme');

  notebookEl = document.getElementById('notebook');
  if (notebookEl) {
    notebookEl.appendChild(cellInserter);
  }

  renderNotebook();
  initSortable();
  setupEventListeners();
  createLightbox();
}

function extractCellsFromScript(scriptContent: string): Cell[] {
  const cellDelimiter =
    /^\/\/\s*---+>?(?:\s*cell\s*\d*\s*)?|\/\/\s*<---+/im;
  const parts = scriptContent.split(cellDelimiter);
  const extractedCells: Cell[] = [];
  let cellIdCounter = 1;

  for (const part of parts) {
    let content = part.trim();
    if (!content) continue;

    // Default to code, but check for markdown hint
    let type: CellType = 'javascript';

    if (content.startsWith('/*markdown')) {
      type = 'markdown';
      content = content
        .replace(/^\/\*markdown/, '')
        .replace(/\*\//, '')
        .trim();
    } else if (content.startsWith('//markdown')) {
      type = 'markdown';
      content = content
        .split('\n')
        .map((line) => line.replace(/^\/\/\s?/, ''))
        .join('\n')
        .trim();
    }
    extractedCells.push(createCell(type, content, `cell-${cellIdCounter++}`));
  }
  return extractedCells;
}

const initialCells: Cell[] = extractCellsFromScript(code);
initialCells.push({
    id: 'cell-4',
    type: 'markdown',
    content: `## Generate an Image

Now, let's use the \`imagen-4.0-generate-001\` model to create an image from a text prompt. Edit the \`prompt\` variable in the code cell below to describe the image you want to create, then run the cell.`,
  },
  {
    id: 'cell-5',
    type: 'javascript',
    content: `import { GoogleGenAI } from "@google/genai";

console.log("Generating...");

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Edit the prompt to describe the image you want to generate.
const prompt = "A watercolor painting of a futuristic city with flying cars.";

try {
  const response = await ai.models.generateImages({
      model: 'imagen-4.0-generate-001',
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: 'image/jpeg',
        aspectRatio: '1:1',
      },
  });

  const base64ImageBytes = response.generatedImages[0].image.imageBytes;
  const imageUrl = \`data:image/jpeg;base64,$\{base64ImageBytes}\`;
  
  // The 'console.log' below is a special command that will be
  // converted to an image tag in the output.
  console.log(imageUrl);

} catch (e) {
  console.error('An error occurred while generating the image:', e);
}`,
  });

cells = initialCells;

main();
