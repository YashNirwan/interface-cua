/**
 * Role + accessible-name computation, expressed as browser-side source.
 *
 * WHY this is a source string rather than a normal module:
 * the computation has to run *inside* every frame of the page (a legacy
 * `<frameset>` app is five documents, not one), and it is also needed by the
 * human-activity recorder, which runs as a page init script. Playwright can
 * only ship code across that boundary as source. Keeping it in one exported
 * string means perception and human-recording compute names with the SAME
 * cascade — if they disagreed, a human-taught step would resolve to a different
 * control on replay, which is exactly the class of bug we cannot afford.
 *
 * WHY we compute names ourselves instead of using Chromium's AX tree:
 * the target class of app has no ARIA, no <label for>, no ids we can trust.
 * The real label of `<td>Member ID:</td><td><input name=ctl00$txtMemberId></td>`
 * is the previous cell, and the browser's accessible name for that input is the
 * empty string. Rule 6 below ("legacy table label") is the whole reason this
 * adapter can drive a frameset-era app semantically instead of by selector.
 */

/**
 * Which rule in the cascade produced the name. Recorded on every node as
 * `hint.nameFrom` so callers can tell a strong name ('aria-label', 'label')
 * from a weak one ('identifier') and decide how much to trust a match.
 */
export type NameFrom =
  | 'aria-labelledby'
  | 'aria-label'
  | 'value'
  | 'label'
  | 'alt'
  | 'caption'
  | 'legend'
  | 'table-label'
  | 'placeholder'
  | 'title'
  | 'content'
  | 'identifier'
  | 'none';

/** Names computed by this cascade are capped so a run-on cell cannot become an id. */
export const NAME_CAP = 120;

/**
 * Browser-side source. Defines (all prefixed `cua` to avoid colliding with
 * whatever globals the legacy app has):
 *
 *   cuaNorm, cuaCap, cuaStripLabel, cuaTextOf, cuaIsVisible,
 *   cuaRole(el)            -> UiRole string
 *   cuaAccessibleName(el)  -> { name, from }
 *   cuaSection(el, lastHeading) -> string
 *   cuaTextNear(el, lastHeading) -> string[]
 *
 * Written with String.raw and no template interpolation, because a normal
 * template literal would eat the backslashes in every regex (`\s` -> `s`) and
 * silently break the whole cascade.
 */
export const ACCESSIBLE_NAME_SCRIPT: string = String.raw`
var CUA_ROLES = ['button','link','textbox','checkbox','radio','combobox','listitem','menuitem','tab','heading','cell','row','table','dialog','alert','image','text','region','generic'];
var CUA_NAME_CAP = 120;
/* A label is short. Anything longer is prose that happens to sit nearby, and
   using it as a name would produce descriptors nobody can review. */
var CUA_LABEL_MAX = 80;

function cuaNorm(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function cuaCap(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n).trim() : s;
}

/* Legacy label cells read "Member ID:" or "Amount *". The trailing punctuation
   is presentation, not identity, so it must not end up in the descriptor. */
function cuaStripLabel(s) {
  return cuaNorm(s).replace(/[\s:\uFF1A*]+$/, '').trim();
}

function cuaAttr(el, n) {
  if (!el || !el.getAttribute) return '';
  return cuaNorm(el.getAttribute(n));
}

/* innerText, not textContent: innerText already respects visibility, so a
   display:none error message does not leak into a control's name. */
function cuaTextOf(el) {
  if (!el) return '';
  var t = '';
  try { t = el.innerText; } catch (e) { t = null; }
  if (t === null || t === undefined) t = el.textContent;
  return cuaNorm(t);
}

function cuaTagOf(el) {
  return el && el.tagName ? el.tagName.toLowerCase() : '';
}

function cuaIsVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hasAttribute('hidden')) return false;
  if (cuaAttr(el, 'aria-hidden') === 'true') return false;
  var tag = cuaTagOf(el);
  var type = cuaAttr(el, 'type').toLowerCase();
  if (tag === 'input' && type === 'hidden') return false;
  var win = el.ownerDocument ? el.ownerDocument.defaultView : null;
  if (win && win.getComputedStyle) {
    var st = win.getComputedStyle(el);
    if (st) {
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    }
  }
  /* An element hidden by an ANCESTOR's display:none still reports its own
     computed display, so the box check is what actually catches that case. */
  if (el.getClientRects && el.getClientRects().length === 0) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return false;
  return true;
}

function cuaIsControl(el) {
  var t = cuaTagOf(el);
  return t === 'input' || t === 'select' || t === 'textarea' || t === 'button';
}

/* A "field" holds a value the user types/picks. Buttons are controls but not
   fields, and the distinction matters: a field with no label borrows the
   neighbouring cell's text (rule 6), a button uses its own text (rule 8). */
function cuaIsField(el) {
  var t = cuaTagOf(el);
  if (t === 'select' || t === 'textarea') return true;
  if (t !== 'input') return false;
  var ty = cuaAttr(el, 'type').toLowerCase();
  return !(ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image');
}

function cuaRole(el) {
  /* An explicit role wins over the tag: that is what ARIA means, and an app
     that bothered to write role="button" on a <td> is telling us something
     the tag cannot. */
  var explicit = cuaAttr(el, 'role').toLowerCase();
  if (explicit) {
    var first = explicit.split(' ')[0];
    if (CUA_ROLES.indexOf(first) >= 0) return first;
    /* Map the few common ARIA roles outside our small vocabulary onto it,
       rather than dropping to 'generic' and losing the semantics. */
    if (first === 'gridcell' || first === 'columnheader' || first === 'rowheader') return 'cell';
    if (first === 'listbox') return 'combobox';
    if (first === 'searchbox') return 'textbox';
    if (first === 'alertdialog') return 'dialog';
    if (first === 'grid' || first === 'treegrid') return 'table';
    if (first === 'banner' || first === 'navigation' || first === 'form' || first === 'main' || first === 'complementary') return 'region';
    if (first === 'option') return 'listitem';
    if (first === 'status') return 'alert';
  }
  var tag = cuaTagOf(el);
  var type = cuaAttr(el, 'type').toLowerCase();
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'hidden') return 'generic';
    /* text | password | email | number | tel | search | date | (missing) */
    return 'textbox';
  }
  if (tag === 'th' || tag === 'td') return 'cell';
  if (tag === 'tr') return 'row';
  if (tag === 'table') return 'table';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'img') return 'image';
  if (tag === 'li') return 'listitem';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'fieldset' || tag === 'form' || tag === 'section' || tag === 'nav' || tag === 'main') return 'region';
  return 'generic';
}

/* ---- rule 6 support: nearest preceding text, DOM order, within a container -- */

function cuaPrecedingTextWithin(container, el) {
  if (!container || !el || !container.ownerDocument) return '';
  var doc = container.ownerDocument;
  var walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  var best = '';
  var n = walker.nextNode();
  while (n) {
    /* Only text that comes BEFORE the control in document order can be its
       label; text after it belongs to the next field. */
    var pos = n.compareDocumentPosition(el);
    var follows = (pos & 4) !== 0; /* DOCUMENT_POSITION_FOLLOWING */
    if (!follows) break;
    if (!el.contains(n)) {
      var pt = n.parentNode ? cuaTagOf(n.parentNode) : '';
      if (pt !== 'script' && pt !== 'style') {
        var t = cuaStripLabel(n.nodeValue);
        if (t && t.length <= CUA_LABEL_MAX) best = t;
      }
    }
    n = walker.nextNode();
  }
  return best;
}

function cuaCellHasControl(cell) {
  if (!cell || !cell.querySelector) return false;
  return !!cell.querySelector('input,select,textarea,button');
}

/**
 * The load-bearing legacy rule. In a table-layout app the label of a field is
 * the text of the cell to its left (or, in "row header" layouts, the first cell
 * of its row). We look in the order the brief specifies, nearest first.
 */
function cuaLegacyTableLabel(el) {
  var cell = el.closest ? el.closest('td,th') : null;
  if (cell) {
    /* (a) the immediately preceding sibling cell — the classic
           <td>Member ID:</td><td><input></td> pair. */
    var prev = cell.previousElementSibling;
    if (prev) {
      var pTag = cuaTagOf(prev);
      if ((pTag === 'td' || pTag === 'th') && !cuaCellHasControl(prev)) {
        var t = cuaStripLabel(cuaTextOf(prev));
        if (t && t.length <= CUA_LABEL_MAX) return t;
      }
    }
    /* (b) any earlier cell in the same row, nearest first — covers a spacer
           cell sitting between the label and the field. */
    var scan = prev ? prev.previousElementSibling : null;
    while (scan) {
      var sTag = cuaTagOf(scan);
      if ((sTag === 'td' || sTag === 'th') && !cuaCellHasControl(scan)) {
        var t2 = cuaStripLabel(cuaTextOf(scan));
        if (t2 && t2.length <= CUA_LABEL_MAX) return t2;
      }
      scan = scan.previousElementSibling;
    }
  }
  /* (c) nearest preceding text node inside the row — covers
         <td>Member ID: <input></td> where label and field share a cell. */
  var row = el.closest ? el.closest('tr') : null;
  if (row) {
    var rt = cuaPrecedingTextWithin(row, el);
    if (rt) return rt;
  }
  /* (d) widen to the table, then (e) to the immediate block. Both are
         last-ditch; they still beat naming the field after ctl00$txtFoo. */
  var table = el.closest ? el.closest('table') : null;
  if (table) {
    var tt = cuaPrecedingTextWithin(table, el);
    if (tt) return tt;
  }
  var block = el.parentElement;
  if (block) {
    var bt = cuaPrecedingTextWithin(block, el);
    if (bt) return bt;
  }
  return '';
}

/* ---- rule 9 support: turn a framework identifier into something readable ---- */

function cuaDeCamel(raw) {
  var s = String(raw || '');
  if (!s) return '';
  /* ASP.NET client ids look like ctl00_MainContent_txtMemberId or
     ctl00$MainContent$txtMemberId; only the last segment carries meaning. */
  if (s.indexOf('$') >= 0 || /^ctl\d+[_$]/i.test(s)) {
    var parts = s.split(/[$_:]/);
    s = parts[parts.length - 1] || s;
  }
  s = s.replace(/^(txt|btn|ddl|chk|rdo|lbl|hdn|cbo|lst|grd|tb|fld|inp)(?=[A-Z_])/, '');
  s = s.replace(/[_\-.]+/g, ' ');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  s = cuaNorm(s);
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The cascade. Order is the contract; 'from' records which rule fired so a
 * caller can see that a name came from an id (weak) rather than a label.
 */
function cuaAccessibleName(el) {
  var doc = el.ownerDocument;
  var tag = cuaTagOf(el);
  var type = cuaAttr(el, 'type').toLowerCase();
  var isField = cuaIsField(el);
  var isControl = cuaIsControl(el);

  /* 1. aria-labelledby */
  var labelledby = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
  if (labelledby) {
    var parts = [];
    var ids = String(labelledby).split(/\s+/);
    for (var i = 0; i < ids.length; i++) {
      if (!ids[i]) continue;
      var ref = doc.getElementById(ids[i]);
      if (ref) {
        var rt = cuaTextOf(ref);
        if (rt) parts.push(rt);
      }
    }
    if (parts.length) return { name: cuaCap(parts.join(' '), CUA_NAME_CAP), from: 'aria-labelledby' };
  }

  /* 2. aria-label */
  var aria = cuaAttr(el, 'aria-label');
  if (aria) return { name: cuaCap(aria, CUA_NAME_CAP), from: 'aria-label' };

  /* 3. value attribute of a push button: <input type=submit value="Search"> is
        the single most common button in this class of app. */
  if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
    var v = cuaAttr(el, 'value');
    if (v) return { name: cuaCap(v, CUA_NAME_CAP), from: 'value' };
    /* Browsers render a value-less submit as "Submit"; name it what the
       operator sees rather than falling through to the id. */
    if (type === 'submit') return { name: 'Submit', from: 'value' };
    if (type === 'reset') return { name: 'Reset', from: 'value' };
  }

  /* 4. <label for=id>, else an ancestor <label> */
  if (isControl) {
    var lbl = null;
    var id = el.getAttribute ? el.getAttribute('id') : null;
    if (id) {
      /* Iterate rather than querySelector: ASP.NET ids contain $ and : which
         would need CSS escaping, and a mis-escape here silently loses labels. */
      var labels = doc.getElementsByTagName('label');
      for (var j = 0; j < labels.length; j++) {
        if (labels[j].getAttribute('for') === id) { lbl = labels[j]; break; }
      }
    }
    if (!lbl) {
      var p = el.parentElement;
      while (p) {
        if (cuaTagOf(p) === 'label') { lbl = p; break; }
        p = p.parentElement;
      }
    }
    if (lbl) {
      var lt = cuaStripLabel(cuaTextOf(lbl));
      if (lt) return { name: cuaCap(lt, CUA_NAME_CAP), from: 'label' };
    }
  }

  /* 5. alt / caption / legend */
  if (tag === 'img' || (tag === 'input' && type === 'image')) {
    var alt = cuaAttr(el, 'alt');
    if (alt) return { name: cuaCap(alt, CUA_NAME_CAP), from: 'alt' };
  }
  if (tag === 'table') {
    var capEl = el.caption || null;
    if (capEl) {
      var ct = cuaTextOf(capEl);
      if (ct) return { name: cuaCap(ct, CUA_NAME_CAP), from: 'caption' };
    }
  }
  if (tag === 'fieldset') {
    var lg = el.querySelector ? el.querySelector('legend') : null;
    if (lg) {
      var gt = cuaTextOf(lg);
      if (gt) return { name: cuaCap(gt, CUA_NAME_CAP), from: 'legend' };
    }
  }

  /* 6. legacy table label — fields only. A <button>Save</button> must NOT be
        named after the cell to its left; its own text is the better name. */
  if (isField) {
    var tl = cuaLegacyTableLabel(el);
    if (tl) return { name: cuaCap(tl, CUA_NAME_CAP), from: 'table-label' };
  }

  /* 7. placeholder, title, alt */
  var ph = cuaAttr(el, 'placeholder');
  if (ph) return { name: cuaCap(ph, CUA_NAME_CAP), from: 'placeholder' };
  var ti = cuaAttr(el, 'title');
  if (ti) return { name: cuaCap(ti, CUA_NAME_CAP), from: 'title' };
  var al2 = cuaAttr(el, 'alt');
  if (al2) return { name: cuaCap(al2, CUA_NAME_CAP), from: 'alt' };

  /* 8. own visible text — links, buttons, headings, cells.
        Excluded for input/textarea (they have no text) and for select (its
        text is the option list, which would make a useless name). */
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    var own = cuaTextOf(el);
    if (own) return { name: cuaCap(own, CUA_NAME_CAP), from: 'content' };
  }

  /* 9. last resort: the framework identifier, de-camel-cased. Marked
        'identifier' so callers know this name will rot when a dev renames a
        control, and can weight the match accordingly. */
  var ident = (el.getAttribute ? (el.getAttribute('name') || el.getAttribute('id')) : '') || '';
  var de = cuaDeCamel(ident);
  if (de) return { name: cuaCap(de, CUA_NAME_CAP), from: 'identifier' };

  return { name: '', from: 'none' };
}

/* ---- section: the primary disambiguator -------------------------------- */

function cuaShort(t) {
  t = cuaNorm(t);
  return t && t.length <= CUA_LABEL_MAX ? t : '';
}

/**
 * Does this element read as a section title? Handles the legacy idioms:
 * a real heading, a bare <b>/<strong>, or a cell whose entire content is bold.
 */
function cuaHeadingTextOf(el) {
  var tag = cuaTagOf(el);
  if (/^h[1-6]$/.test(tag)) return cuaShort(cuaTextOf(el));
  if (tag === 'legend' || tag === 'caption') return cuaShort(cuaTextOf(el));
  if (tag === 'b' || tag === 'strong') return cuaShort(cuaTextOf(el));
  if (tag === 'font' || tag === 'span' || tag === 'p' || tag === 'div' || tag === 'center' || tag === 'td' || tag === 'th') {
    var inner = el.querySelector ? el.querySelector('h1,h2,h3,h4,h5,h6,b,strong') : null;
    if (inner) {
      var whole = cuaTextOf(el);
      /* Only a title if the bold run IS the whole content — otherwise we would
         mistake a bolded word inside a sentence for a section name. */
      if (whole && cuaNorm(inner.textContent) === whole) return cuaShort(whole);
    }
  }
  return '';
}

/** Nearest title-ish element before 'node', climbing a few levels. */
function cuaHeadingBefore(node) {
  var n = node;
  var climbed = 0;
  while (n && climbed < 4) {
    var sib = n.previousElementSibling;
    while (sib) {
      var t = cuaHeadingTextOf(sib);
      if (t) return t;
      sib = sib.previousElementSibling;
    }
    n = n.parentElement;
    climbed++;
    if (!n || cuaTagOf(n) === 'body' || cuaTagOf(n) === 'html') break;
  }
  return '';
}

/**
 * A table's own title. This is what distinguishes two identical "View" buttons
 * sitting in an Accounts table from those in a Recent Activity table:
 *   1. <caption>
 *   2. a single-cell first row used as a banner (the legacy idiom)
 *   3. a heading immediately before the table
 */
function cuaTableTitle(table) {
  if (table.caption) {
    var ct = cuaShort(cuaTextOf(table.caption));
    if (ct) return ct;
  }
  var rows = table.rows;
  if (rows && rows.length) {
    var first = rows[0];
    if (first && first.cells && first.cells.length === 1) {
      var c = first.cells[0];
      /* A banner row holds short text and no nested table or control. */
      if (!cuaCellHasControl(c) && !(c.querySelector && c.querySelector('table'))) {
        var bt = cuaShort(cuaTextOf(c));
        if (bt) return bt;
      }
    }
  }
  return cuaHeadingBefore(table);
}

/**
 * Nearest enclosing named context, searched OUTWARD, so the innermost thing
 * that has a name wins. 'lastHeading' is the nearest preceding heading in
 * document order, supplied by the walker (which sees document order for free)
 * and used only when nothing structural names the region.
 */
function cuaSection(el, lastHeading) {
  var a = el.parentElement;
  var depth = 0;
  while (a && depth < 40) {
    var tag = cuaTagOf(a);
    var role = cuaAttr(a, 'role').toLowerCase();
    if (tag === 'fieldset') {
      var lg = a.querySelector ? a.querySelector('legend') : null;
      if (lg) { var lt = cuaShort(cuaTextOf(lg)); if (lt) return lt; }
    }
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') {
      var dn = cuaAttr(a, 'aria-label');
      if (!dn) {
        var dh = a.querySelector ? a.querySelector('h1,h2,h3,h4,h5,h6,legend,caption') : null;
        if (dh) dn = cuaTextOf(dh);
      }
      var dt = cuaShort(dn);
      if (dt) return dt;
    }
    if (tag === 'table') {
      var tt = cuaTableTitle(a);
      if (tt) return tt;
    }
    if (tag === 'section' || tag === 'form' || role === 'region') {
      var rn = cuaAttr(a, 'aria-label');
      if (!rn) rn = cuaHeadingBefore(a);
      var rt = cuaShort(rn);
      if (rt) return rt;
    }
    a = a.parentElement;
    depth++;
  }
  return cuaShort(lastHeading);
}

/**
 * Up to three short neighbouring texts. In legacy apps this is the de-facto
 * label and it is what the 'near-text' resolution tier matches on, so it must
 * stay small and stable: previous cell, row's first cell, preceding heading.
 */
function cuaTextNear(el, lastHeading) {
  var out = [];
  function push(t) {
    t = cuaStripLabel(t);
    if (!t || t.length > CUA_LABEL_MAX) return;
    if (out.indexOf(t) >= 0) return;
    out.push(t);
  }
  var cell = el.closest ? el.closest('td,th') : null;
  if (cell) {
    var prev = cell.previousElementSibling;
    while (prev) {
      var pt = cuaTagOf(prev);
      if (pt === 'td' || pt === 'th') { push(cuaTextOf(prev)); break; }
      prev = prev.previousElementSibling;
    }
  }
  var row = el.closest ? el.closest('tr') : null;
  if (row && row.cells && row.cells.length) {
    var firstCell = row.cells[0];
    if (firstCell && firstCell !== cell) push(cuaTextOf(firstCell));
  }
  if (lastHeading) push(lastHeading);
  return out.slice(0, 3);
}
`;
