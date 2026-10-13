// media/chat.js
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const newChatBtn = document.getElementById('new-chat');
  const toastEl = document.getElementById('toast');
  const attachBtn = document.getElementById('attach');
  const tabsBox = document.getElementById('tabs');
  const attachmentsEl = document.getElementById('attachments');
  const historyBtn = document.getElementById('history-btn');
  const historySearch = document.getElementById('history-search');
  const historyList = document.getElementById('history-list');

  const EMPTY_HTML =
    '<div id="empty" class="empty">' +
    '<p><strong>Ask about your code.</strong></p>' +
    '<p class="hint">Use the <strong>+</strong> button or type <code>@filename</code> to add more files as context.</p>' +
    '</div>';

  /** id -> { el: HTMLElement, raw: string } */
  const live = new Map();
  let busy = false;
  let historyItems = [];

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function post(message) {
    vscode.postMessage(message);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 1600);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    stopBtn.hidden = !value;
    document.body.classList.toggle('busy', value);
  }

  function refreshEmptyState() {
    const empty = document.getElementById('empty');
    if (!empty) return;
    empty.style.display = messagesEl.querySelector('.msg') ? 'none' : 'block';
  }

  function resetMessages() {
    messagesEl.innerHTML = EMPTY_HTML;
    live.clear();
    refreshEmptyState();
  }

  // ---------------------------------------------------------------------------
  // Markdown rendering (small, dependency-free subset)
  // ---------------------------------------------------------------------------

  function inlineFmt(text) {
    const codes = [];

    // Protect inline code first.
    let out = text.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );

    out = out.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return '<code>' + codes[Number(index)] + '</code>';
    });

    return out;
  }

  function renderBlocks(escaped) {
    const lines = escaped.split('\n');
    let html = '';
    let inList = false;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length) {
        html += '<p>' + inlineFmt(paragraph.join(' ')) + '</p>';
        paragraph = [];
      }
    }

    function closeList() {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        html += '<h' + level + '>' + inlineFmt(heading[2]) + '</h' + level + '>';
      } else if (bullet || ordered) {
        flushParagraph();
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += '<li>' + inlineFmt((bullet || ordered)[1]) + '</li>';
      } else if (/^\s*$/.test(line)) {
        flushParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }

    flushParagraph();
    closeList();
    return html;
  }

  function codeBlockHtml(code, lang) {
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      '<span class="code-lang">' +
      escapeHtml(lang || 'code') +
      '</span>' +
      '<span class="code-actions">' +
      '<button class="mini" data-act="copy">Copy</button>' +
      '<button class="mini" data-act="insert">Insert</button>' +
      '</span>' +
      '</div>' +
      '<pre><code>' +
      escapeHtml(code) +
      '</code></pre>' +
      '</div>'
    );
  }

  function renderMarkdown(markdown) {
    const parts = String(markdown).split('```');
    let html = '';

    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // Fenced code block.
        let chunk = parts[i];
        let lang = '';
        const newline = chunk.indexOf('\n');

        if (newline !== -1) {
          const firstLine = chunk.slice(0, newline).trim();
          if (/^[\w+#.-]*$/.test(firstLine)) {
            lang = firstLine;
            chunk = chunk.slice(newline + 1);
          }
        }

        html += codeBlockHtml(chunk.replace(/\n$/, ''), lang);
      } else {
        html += renderBlocks(escapeHtml(parts[i]));
      }
    }

    return html;
  }

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------

  function addUserBubble(text, contextLabel) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML =
      '<div class="bubble">' +
      escapeHtml(text).replace(/\n/g, '<br>') +
      '</div>' +
      (contextLabel ? '<div class="ctx">' + escapeHtml(contextLabel) + '</div>' : '');
    messagesEl.appendChild(el);
    refreshEmptyState();
    scrollToBottom();
  }

  function addAssistantBubble(id, preRenderedHtml) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML =
      '<div class="bubble">' +
      (preRenderedHtml !== undefined ? preRenderedHtml : '<span class="typing">…</span>') +
      '</div>';
    messagesEl.appendChild(el);

    if (preRenderedHtml === undefined) {
      live.set(id, { el: el.querySelector('.bubble'), raw: '' });
    }

    refreshEmptyState();
    scrollToBottom();
  }

  function appendDelta(id, text) {
    const entry = live.get(id);
    if (!entry) return;
    entry.raw += text;
    entry.el.innerHTML = renderMarkdown(entry.raw);
    scrollToBottom();
  }

  function finishAssistant(id, errorText) {
    const entry = live.get(id);
    if (!entry) return;

    if (errorText) {
      entry.el.innerHTML =
        '<div class="error">' + escapeHtml(errorText) + '</div>' + entry.el.innerHTML;
    } else if (!entry.raw) {
      entry.el.innerHTML = '<em>No response.</em>';
    }

    live.delete(id);
    scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // Attached files (chips) + open-tabs toggle
  // ---------------------------------------------------------------------------

  function renderAttachments(items, tabs) {
    tabsBox.checked = !!tabs;
    attachmentsEl.innerHTML = items
      .map(function (p) {
        return (
          '<span class="chip">' +
          escapeHtml(p) +
          '<button class="chip-x" data-path="' +
          escapeHtml(p) +
          '" title="Remove">&times;</button></span>'
        );
      })
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Past chats (history + search)
  // ---------------------------------------------------------------------------

  function formatDate(ts) {
    const d = new Date(ts);
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
  }

  function renderHistory() {
    const q = historySearch.value.trim().toLowerCase();
    const items = historyItems.filter(function (it) {
      return !q || it.title.toLowerCase().indexOf(q) !== -1 || it.searchText.indexOf(q) !== -1;
    });

    if (!items.length) {
      historyList.innerHTML =
        '<p class="hint">' + (q ? 'No chats match your search.' : 'No saved chats yet.') + '</p>';
      return;
    }

    historyList.innerHTML = items
      .map(function (it) {
        return (
          '<div class="history-item" data-id="' + escapeHtml(it.id) + '">' +
          '<div class="history-main">' +
          '<div class="history-title">' + escapeHtml(it.title) + '</div>' +
          '<div class="history-meta">' + escapeHtml(formatDate(it.updatedAt)) + ' · ' + it.count + ' messages</div>' +
          '</div>' +
          '<button class="mini history-del" data-del="' + escapeHtml(it.id) + '" title="Delete this chat">&times;</button>' +
          '</div>'
        );
      })
      .join('');
  }

  function setHistoryOpen(open) {
    document.body.classList.toggle('history-open', open);
    if (open) {
      historySearch.value = '';
      post({ type: 'historyOpen' });
      historySearch.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Extension -> webview
  // ---------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    const msg = event.data || {};

    switch (msg.type) {
      case 'restore':
        resetMessages();
        (msg.items || []).forEach(function (item) {
          if (item.role === 'user') {
            addUserBubble(item.text, item.context);
          } else {
            addAssistantBubble(item.id, renderMarkdown(item.text));
          }
        });
        scrollToBottom();
        break;

      case 'user':
        addUserBubble(msg.text, msg.context);
        break;

      case 'assistantStart':
        addAssistantBubble(msg.id);
        break;

      case 'delta':
        appendDelta(msg.id, msg.text);
        break;

      case 'assistantEnd':
        finishAssistant(msg.id, msg.error);
        break;

      case 'busy':
        setBusy(!!msg.value);
        break;

      case 'clear':
        resetMessages();
        break;

      case 'toast':
        toast(msg.text);
        break;

      case 'attachments':
        renderAttachments(msg.items || [], msg.tabs);
        break;

      case 'historyList':
        historyItems = msg.items || [];
        renderHistory();
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function submit() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    autoGrow();
    post({ type: 'send', text: text });
  }

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', function () {
    post({ type: 'stop' });
  });
  newChatBtn.addEventListener('click', function () {
    setHistoryOpen(false);
    post({ type: 'newChat' });
  });

  historyBtn.addEventListener('click', function () {
    setHistoryOpen(!document.body.classList.contains('history-open'));
  });
  historySearch.addEventListener('input', renderHistory);
  historyList.addEventListener('click', function (event) {
    const del = event.target.closest('[data-del]');
    if (del) {
      post({ type: 'historyDelete', id: del.dataset.del });
      return;
    }
    const item = event.target.closest('.history-item');
    if (item) {
      setHistoryOpen(false);
      post({ type: 'historyLoad', id: item.dataset.id });
    }
  });

  attachBtn.addEventListener('click', function () {
    post({ type: 'attach' });
  });
  tabsBox.addEventListener('change', function () {
    post({ type: 'tabs', value: tabsBox.checked });
  });
  attachmentsEl.addEventListener('click', function (event) {
    const remove = event.target.closest('.chip-x');
    if (remove) {
      post({ type: 'detach', path: remove.dataset.path });
    }
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  // ---------------------------------------------------------------------------
  // Code block buttons (event delegation)
  // ---------------------------------------------------------------------------

  messagesEl.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-act]');
    if (!button) return;

    const block = button.closest('.code-block');
    if (!block) return;

    const codeEl = block.querySelector('code');
    const code = codeEl ? codeEl.textContent : '';
    if (!code) return;

    if (button.dataset.act === 'copy') {
      post({ type: 'copy', code: code });
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () {
        button.textContent = original;
      }, 1200);
    } else {
      post({ type: 'insert', code: code });
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  resetMessages();
  autoGrow();
  post({ type: 'ready' });
})();