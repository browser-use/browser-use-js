import { setTimeout as delay } from 'node:timers/promises';
import type { Protocol } from 'devtools-protocol';
import type { Page } from './page.js';
import type { CDP } from './cdp.js';

type AX = Protocol.Accessibility.AXNode;
const CONTROLS = new Set(
  'button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton tab menuitem menuitemcheckbox menuitemradio treeitem'.split(
    ' ',
  ),
);
/** Text inside these is one line; text across them is not joined. */
const BLOCKS = new Set(['paragraph', 'listitem', 'row', 'LabelText']);
const NATIVE_INPUTS = new Set(['Date', 'DateTime', 'InputTime']);
const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const prop = (n: AX, name: string) => n.properties?.find((p) => p.name === name)?.value.value;
const isContextLoss = (e: unknown) =>
  /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated|Target closed|No frame/.test(
    String(e instanceof Error ? e.message : e),
  );
const isGone = (e: unknown) =>
  /No node with given id|Could not find node|Target detached/.test(String(e));
/** A line the call already printed: the REPL's echo of the returned value stays empty. */
const printed = (line: string) =>
  Object.defineProperty(new String(line), Symbol.for('nodejs.util.inspect.custom'), {
    value: () => '',
  });

/** Appended to the system prompt in ultrafast mode. */
export const AX_PROMPT = `

Ultrafast: the global \`bu\` in the javascript REPL. Each model call costs ~1 s, so chain everything you already know into one javascript call.
- Look: await page.goto(url); await bu.state() prints the page in order: [id] role "name" = value plus states, ## headings and visible text; * marks ids new since the last look.
  Ids are Chrome backendNodeIds: they work in bu.* and in every CDP DOM command.
- Act: await bu.click(1400); await bu.type(812, 'Zurich'); await bu.type(830, 'Oct 14', {enter: true}). type replaces the field's text; on a <select> it picks the option with that label.
  Each action prints one line: navigated to <url> / page changed / no change. Autocomplete: type, look, then click the suggestion.
- Element code: await bu.js(1400, (el, arg) => el.innerText, arg) runs on that element in the page and returns the value.
- Raw: upload await page.cdp('DOM.setFileInputFiles', {backendNodeId: id, files: [path]}); keys await page.cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}) then the same with type 'keyUp'; drag with Input.dispatchMouseEvent mousePressed, mouseMoved, mouseReleased.
- If a helper fails once, do it raw. Read data with page.evaluate(() => ...).
- Never add blind sleeps (setTimeout): actions and bu.state() wait for the page; look with bu.state() when results may still be loading.
`;

/** State print and id-based actions on Chrome's accessibility tree. Raw page/CDP stays available. */
export class AxHelpers {
  constructor(
    private page: () => Page,
    private browser: () => CDP,
    private log: (text: string) => void,
  ) {}

  private inflight = new Map<string, Map<string, number>>();
  private lastNet = new Map<string, number>();
  private tracked = new Set<string>();
  private dialogs: string[] = [];
  /** Role and name of every id in the last print: marks new ids and re-finds re-rendered ones. */
  private last = new Map<number, { role: string; name: string }>();

  /** Track in-flight requests per page session from CDP Network events (no page patching). */
  private async trackNetwork(page: Page) {
    const cdp = this.browser();
    if (!(cdp as { __buTracked?: boolean }).__buTracked) {
      const previous = cdp.observeEvent;
      cdp.observeEvent = (method, raw, session) => {
        previous?.(method, raw, session);
        // An open alert/confirm blocks the page and every CDP call on it: accept it and report its text.
        if (method === 'Page.javascriptDialogOpening') {
          const d = raw as { type: string; message: string; defaultPrompt?: string };
          this.dialogs.push(
            `[dialog ${d.type}] ${JSON.stringify(clip(d.message, 300))} (accepted)`,
          );
          void cdp
            .send(
              'Page.handleJavaScriptDialog',
              { accept: true, promptText: d.defaultPrompt ?? '' },
              session,
            )
            .catch(() => {});
          return;
        }
        if (method === 'Target.detachedFromTarget') {
          const gone = (raw as { sessionId: string }).sessionId;
          this.inflight.delete(gone);
          this.lastNet.delete(gone);
          this.tracked.delete(gone);
          return;
        }
        if (!session || !method.startsWith('Network.')) return;
        const params = raw as { requestId: string; type?: string };
        const map = this.inflight.get(session) ?? new Map<string, number>();
        this.inflight.set(session, map);
        if (method === 'Network.requestWillBeSent') {
          if (
            !['WebSocket', 'EventSource', 'Media', 'Ping', 'Manifest'].includes(params.type ?? '')
          )
            map.set(params.requestId, Date.now());
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed')
          map.delete(params.requestId);
        else return;
        this.lastNet.set(session, Date.now());
      };
      (cdp as { __buTracked?: boolean }).__buTracked = true;
    }
    const session = page.sessionId || (await page.info().then(() => page.sessionId));
    if (session && !this.tracked.has(session)) {
      this.tracked.add(session);
      await page.cdp('Network.enable', {}).catch(() => this.tracked.delete(session));
    }
    return session;
  }

  /** URL, document identity and a counter of DOM mutations (style aside) and form input/change events. */
  private probe(page: Page) {
    return page.evaluate(() => {
      const w = window as unknown as {
        __buObs?: MutationObserver;
        __buLast: number;
        __buN: number;
        __buDoc: number;
      };
      if (!w.__buObs) {
        w.__buLast = performance.now();
        w.__buN = 0;
        w.__buDoc = Math.random();
        w.__buObs = new MutationObserver((records) => {
          w.__buLast = performance.now();
          if (records.some((r) => r.attributeName !== 'style')) w.__buN++;
        });
        w.__buObs.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        for (const type of ['input', 'change']) addEventListener(type, () => w.__buN++, true);
      }
      return {
        idle: performance.now() - w.__buLast,
        ready: document.readyState,
        url: location.href,
        n: w.__buN,
        doc: w.__buDoc,
      };
    });
  }

  /**
   * Event-based wait, never a fixed sleep: document parsed, no fresh in-flight requests
   * (older than 1.5 s are treated as long-poll/analytics), and no DOM mutation for quietMs. Bounded by capMs.
   */
  async settle(options: { capMs?: number; quietMs?: number; page?: Page } = {}) {
    const page = options.page ?? this.page();
    const cap = options.capMs ?? 800;
    const quiet = options.quietMs ?? 80;
    const start = Date.now();
    const session = await this.trackNetwork(page).catch(() => undefined);
    let limit = cap;
    let pending = 0;
    while (Date.now() - start < limit) {
      try {
        const probe = await this.probe(page);
        const now = Date.now();
        if (probe.ready === 'loading') limit = Math.max(cap, 3000); // navigations need longer than in-page updates
        probe.idle = Math.min(probe.idle, now - start); // quiet must be observed after this action began
        pending = session
          ? [...(this.inflight.get(session)?.values() ?? [])].filter((t) => now - t < 1500).length
          : 0;
        const netIdle = session ? now - (this.lastNet.get(session) ?? 0) : quiet;
        if (probe.ready !== 'loading' && probe.idle >= quiet && pending === 0 && netIdle >= quiet)
          return { why: 'quiet', pending, ms: now - start };
      } catch (error) {
        // Navigation in progress: wait for the new document. Anything else ends the wait, never the action.
        if (!isContextLoss(error)) return { why: 'error', pending, ms: Date.now() - start };
      }
      await delay(40);
    }
    return { why: 'cap', pending, ms: Date.now() - start };
  }

  private flushDialogs() {
    return this.dialogs.length ? `\n${this.dialogs.splice(0).join('\n')}` : '';
  }

  /**
   * Text actually shown, lowercased with whitespace collapsed. The AX tree keeps opacity:0 text (pre-rendered
   * success banners), which agents then report as success; checkVisibility with checkOpacity drops it.
   */
  private visibleText(page = this.page()) {
    return page.evaluate(() => {
      const out: string[] = [];
      const shown = new Map<Element, boolean>();
      const roots: Node[] = [document];
      for (let i = 0; i < roots.length; i++) {
        const walk = document.createTreeWalker(
          roots[i]!,
          NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        );
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const el = n as Element & { contentDocument?: Document | null };
            if (el.shadowRoot) roots.push(el.shadowRoot);
            if (el.contentDocument) roots.push(el.contentDocument); // same-origin iframe
            continue;
          }
          const e = n.parentElement;
          if (!e || !n.textContent?.trim()) continue;
          if (!shown.has(e))
            shown.set(e, e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
          if (shown.get(e)) out.push(n.textContent);
        }
      }
      return out.join(' ').replace(/\s+/g, ' ').toLowerCase();
    });
  }

  /** AX trees of the main frame and of every same-process child frame (other frames fail and are skipped). */
  private async capture(page: Page) {
    for (let i = 0; ; i++) {
      try {
        const [{ nodes }, { frameTree }] = await Promise.all([
          page.cdp('Accessibility.getFullAXTree'),
          page.cdp('Page.getFrameTree'),
        ]);
        const children: { url: string; id: string }[] = [];
        const walk = (tree: typeof frameTree) =>
          tree.childFrames?.forEach((child) => {
            children.push({ url: child.frame.url, id: child.frame.id });
            walk(child);
          });
        walk(frameTree);
        const frames = await Promise.all(
          children.map(({ url, id }) =>
            page.cdp('Accessibility.getFullAXTree', { frameId: id }).then(
              (r) => ({ url, nodes: r.nodes }),
              () => ({ url, nodes: [] as AX[] }),
            ),
          ),
        );
        return [{ url: '', nodes }, ...frames];
      } catch (error) {
        if (i >= 20 || !isContextLoss(error)) throw error;
        await delay(50);
      }
    }
  }

  /** The page as one list in page order; only the newest print stays in the model's context. */
  async state(options: { max?: number } = {}) {
    const page = this.page();
    const settled = await this.settle({ capMs: 3000 });
    const [frames, info, visible, targets] = await Promise.all([
      this.capture(page),
      page.info(),
      this.visibleText(page).catch(() => undefined),
      this.browser().send('Target.getTargets'),
    ]);
    const previous = this.last;
    this.last = new Map();
    const lines: string[] = [];
    const text: string[] = [];
    const flush = () => text.length && lines.push(text.splice(0).join(' '));
    for (const frame of frames) {
      const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
      const start = lines.length;
      const walk = (n: AX | undefined, inside: string) => {
        if (!n) return;
        const role = String(n.role?.value ?? '');
        const name = norm(n.name?.value);
        const kids = () => n.childIds?.forEach((c) => walk(byId.get(c), inside));
        if (n.ignored) return kids();
        if (role === 'StaticText') {
          const t = name.toLowerCase();
          if (t && !inside.includes(t) && (visible === undefined || visible.includes(t)))
            text.push(name);
          return;
        }
        if (role === 'heading' && name) {
          flush();
          lines.push(`## ${name}`);
          inside = name.toLowerCase();
          return kids();
        }
        const id = n.backendDOMNodeId;
        if (!id || !(CONTROLS.has(role) || (prop(n, 'focusable') && role !== 'RootWebArea'))) {
          if (!BLOCKS.has(role)) return kids();
          flush();
          kids();
          return flush();
        }
        if (text.at(-1)?.toLowerCase() === name.toLowerCase()) text.pop(); // its label, printed as its name
        flush();
        const shown = role === 'generic' && prop(n, 'editable') ? 'textbox' : role;
        const value = norm(n.value?.value);
        const states = [
          prop(n, 'checked') === undefined
            ? ''
            : prop(n, 'checked') === 'false'
              ? 'unchecked'
              : 'checked',
          prop(n, 'expanded') === undefined ? '' : prop(n, 'expanded') ? 'expanded' : 'collapsed',
          ...['selected', 'disabled', 'focused'].map((p) => (prop(n, p) ? p : '')),
        ].filter(Boolean);
        // A native <select> keeps its options in a popup child: summarize them instead of listing each.
        const popup = n.childIds
          ?.map((c) => byId.get(c))
          .find((c) => c?.role?.value === 'MenuListPopup');
        const options: string[] = [];
        const collect = (c?: AX): unknown =>
          c?.role?.value === 'option'
            ? options.push(norm(c.name?.value))
            : c?.childIds?.forEach((k) => collect(byId.get(k)));
        collect(popup);
        this.last.set(id, { role: shown, name });
        lines.push(
          `${previous.size && !previous.has(id) ? '*' : ''}[${id}] ${shown}${name ? ` "${clip(name, 150)}"` : ''}${value ? ` = ${JSON.stringify(clip(value, 100))}` : ''}${states.length ? ` ${states.join(' ')}` : ''}${options.length ? `  options: ${options.slice(0, 5).join(' | ')}${options.length > 5 ? ` | … ${options.length - 5} more` : ''}` : ''}`,
        );
        if (popup || NATIVE_INPUTS.has(role)) return; // their children are the browser's own widget parts
        inside = `${inside} ${name} ${value}`.toLowerCase();
        kids();
        flush();
      };
      walk(frame.nodes[0], '');
      flush();
      if (frame.url && lines.length > start) lines.splice(start, 0, `--- frame ${frame.url} ---`);
    }
    const tabs = targets.targetInfos.filter(
      (t) => t.type === 'page' && t.url !== 'about:blank',
    ).length;
    const header = `[state] ${info.title} | ${info.url}${tabs > 1 ? ` | ${tabs} tabs` : ''}${settled.pending ? ` | loading: ${settled.pending}` : ''}${this.flushDialogs()}`;
    const max = options.max ?? 8000;
    const fit = (from: string[], budget: number) => {
      let size = 0;
      const n = from.findIndex((l) => (size += l.length + 1) > budget);
      return n < 0 ? from.length : n;
    };
    let body = lines;
    // Over max, keep the top and the last fifth: a dialog's Done/Submit is usually its last line.
    if (fit(lines, max) < lines.length) {
      const head = fit(lines, max * 0.8);
      const tail = fit(lines.toReversed(), max * 0.2);
      body = [
        ...lines.slice(0, head),
        `... ${lines.length - head - tail} lines cut here (bu.state({max: 30000}) or page.evaluate)`,
        ...lines.slice(lines.length - tail),
      ];
    }
    this.log(`${header}\n${body.join('\n')}\n[/state]`);
  }

  private async onNode<T>(page: Page, id: number, fn: string, argument?: unknown): Promise<T> {
    const { object } = await page.cdp('DOM.resolveNode', { backendNodeId: id });
    if (!object.objectId) throw new Error('Node unavailable.');
    try {
      const response = await page.cdp('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: [{ value: argument }],
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          (response.exceptionDetails.exception?.description ?? 'Node operation failed.').split(
            '\n    at ',
          )[0],
        );
      return response.result.value as T;
    } finally {
      await page.cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  private describe(id: number) {
    const n = this.last.get(id);
    return n ? `[${id}] ${n.role}${n.name ? ` "${clip(n.name, 60)}"` : ''}` : `[${id}]`;
  }

  /** Runs fn on id; when that node is gone (re-rendered), re-finds it once by the role and name of the last print. */
  private async onLive<T>(page: Page, id: number, fn: (id: number) => Promise<T>) {
    try {
      return { id, value: await fn(id), note: '' };
    } catch (error) {
      const was = this.last.get(id);
      if (!isGone(error) || !was) throw error;
      const nodes = (await this.capture(page)).flatMap((f) => f.nodes).filter((n) => !n.ignored);
      const same = nodes.filter(
        (n) =>
          n.backendDOMNodeId &&
          String(n.role?.value) === was.role &&
          norm(n.name?.value) === was.name,
      );
      if (same.length !== 1) {
        const near = nodes.filter((n) => n.backendDOMNodeId && norm(n.name?.value) === was.name);
        throw new Error(
          `STALE: ${this.describe(id)} is gone and ${same.length} nodes now match its role and name.${
            near.length
              ? ` Candidates: ${near
                  .slice(0, 5)
                  .map((n) => `[${n.backendDOMNodeId}] ${n.role?.value} "${clip(was.name, 60)}"`)
                  .join(', ')}`
              : ''
          } Look again with bu.state().`,
        );
      }
      const again = same[0]!.backendDOMNodeId!;
      this.last.set(again, was);
      return { id: again, value: await fn(again), note: ` (was [${id}], re-rendered)` };
    }
  }

  /** Scroll into view and return a clickable, unobstructed center point, or throw a precise reason. */
  private async point(page: Page, id: number, editableCover = false) {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => {});
    const p = await this.onNode<{ x: number; y: number; covered: boolean }>(
      page,
      id,
      `function(editableCover) {
        const e = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!e || !e.isConnected) throw Error('Target detached');
        if (e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]')) throw Error('Target disabled');
        if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) throw Error('Target hidden');
        const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw Error('Target outside viewport');
        const hit = e.getRootNode().elementFromPoint(x, y);
        const textField = (n) => n && (['INPUT','TEXTAREA'].includes(n.tagName) || n.isContentEditable);
        const covered = !e.contains(hit) && !(hit && hit.contains(e) && getComputedStyle(hit).pointerEvents !== 'none' && hit.tagName === 'LABEL') && !(editableCover && textField(e) && textField(hit));
        // Inside same-origin iframes, add each frame's content-box offset to get top-level viewport coordinates.
        let px = x, py = y;
        for (let w = e.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
          const f = w.frameElement, fr = f.getBoundingClientRect(), cs = getComputedStyle(f);
          px += fr.x + f.clientLeft + parseFloat(cs.paddingLeft);
          py += fr.y + f.clientTop + parseFloat(cs.paddingTop);
        }
        return {x: px, y: py, covered};
      }`,
      editableCover,
    );
    if (!p.covered) return p;
    const hit = await page
      .cdp('DOM.getNodeForLocation', { x: Math.round(p.x), y: Math.round(p.y) })
      .catch(() => undefined);
    const tree = hit
      ? await page
          .cdp('Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId })
          .catch(() => undefined)
      : undefined;
    // The node under the point and its ancestors: name the nearest one with a name or a dialog role.
    const byId = new Map(tree?.nodes.map((n) => [n.nodeId, n]));
    let n = tree?.nodes.find((a) => a.backendDOMNodeId === hit?.backendNodeId);
    while (n && (n.ignored || !(norm(n.name?.value) || /dialog/.test(String(n.role?.value)))))
      n = n.parentId ? byId.get(n.parentId) : undefined;
    throw new Error(
      `Target covered by ${n ? `[${n.backendDOMNodeId}] ${n.role?.value} "${clip(norm(n.name?.value), 60)}"` : hit ? `[${hit.backendNodeId}]` : 'another element'}; nothing was clicked`,
    );
  }

  /** Runs one action on id and prints one line: navigated to <url> / page changed / no change. */
  private async act(op: string, id: number, body: (page: Page, id: number) => Promise<string>) {
    const page = this.page();
    await this.trackNetwork(page).catch(() => {});
    const before = await this.probe(page).catch(() => undefined);
    let done: { id: number; value: string; note: string };
    try {
      done = await this.onLive(page, id, (i) => body(page, i));
    } catch (error) {
      throw new Error(
        `${op} ${this.describe(id)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.settle();
    const line = `[ok] ${op} ${this.describe(done.id)}${done.value}${done.note} -> ${await this.change(before)}${this.flushDialogs()}`;
    this.log(line);
    return printed(line);
  }

  private async change(before: Awaited<ReturnType<AxHelpers['probe']>> | undefined) {
    const after = await this.probe(this.page()).catch(() => undefined);
    if (!before || !after) return 'page changed';
    if (after.doc !== before.doc || after.url !== before.url) return `navigated to ${after.url}`;
    return after.n !== before.n ? 'page changed' : 'no change';
  }

  async click(id: number) {
    return this.act('click', id, async (page, i) => {
      const p = await this.point(page, i);
      await page.clickAt(p.x, p.y);
      return '';
    });
  }

  async type(id: number, text: string, options: { enter?: boolean } = {}) {
    if (typeof text !== 'string') throw new Error('type needs a string.');
    return this.act('type', id, async (page, i) => {
      const kind = await this.onNode<{ tag: string; type: string }>(
        page,
        i,
        `function(){const e=this.nodeType===1?this:this.parentElement;if(!e||!e.isConnected)throw Error('Target detached');return {tag:e.tagName,type:e.type||''};}`,
      );
      if (kind.tag === 'SELECT') {
        const label = await this.onNode<string>(
          page,
          i,
          `function(want){
            const n = s => String(s).replace(/\\s+/g,' ').trim().toLowerCase(), opts = [...this.options].filter(o => !o.disabled);
            const o = opts.find(o => n(o.label) === n(want) || n(o.value) === n(want)) ?? opts.find(o => n(o.label).startsWith(n(want)));
            if (!o) throw Error('no option ' + JSON.stringify(want) + '. Options: ' + opts.slice(0, 40).map(o => o.label).join(' | '));
            this.value = o.value;
            this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
            return o.label;
          }`,
          text,
        );
        return ` = ${JSON.stringify(label)}`;
      }
      if (
        kind.tag === 'INPUT' &&
        ['date', 'time', 'datetime-local', 'month', 'week'].includes(kind.type)
      ) {
        await this.onNode(
          page,
          i,
          `function(v){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(this,v);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));if(this.value!==v)throw Error('Invalid native date/time value; use its ISO format');}`,
          text,
        );
        return ` = ${JSON.stringify(text)}`;
      }
      const p = await this.point(page, i, true);
      await page.clickAt(p.x, p.y);
      // Comboboxes often move focus to their own overlay input on click; type there, not into the hidden original.
      const moved = await this.onNode<boolean>(
        page,
        i,
        `function(){const e=this.nodeType===1?this:this.parentElement;let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return !!a&&a!==e&&!e.contains(a)&&(['INPUT','TEXTAREA'].includes(a.tagName)||a.isContentEditable);}`,
      ).catch(() => false);
      if (!moved) await page.cdp('DOM.focus', { backendNodeId: i }).catch(() => {});
      const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 };
      await page.cdp('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        ...a,
        commands: ['selectAll'],
      });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...a });
      if (text === '') await this.key(page, 'Backspace', 8);
      else {
        // Datepickers and autocompletes react to key events, which insertText never sends: type the last character as a key.
        const chars = [...text];
        const last = chars.pop()!;
        if (chars.length) await page.cdp('Input.insertText', { text: chars.join('') });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: last, text: last });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: last });
      }
      const actual = await (
        moved
          ? page.evaluate(() => {
              let a = document.activeElement as HTMLInputElement | null;
              while (a?.shadowRoot?.activeElement)
                a = a.shadowRoot.activeElement as HTMLInputElement;
              return a ? (a.isContentEditable ? a.innerText : (a.value ?? '')) : '';
            })
          : this.onNode<string>(
              page,
              i,
              `function(){const e=this.nodeType===1?this:this.parentElement;return e.isContentEditable?e.innerText:(e.value??'');}`,
            )
      ).catch(() => undefined);
      if (options.enter) await this.key(page, 'Enter', 13, '\r');
      return ` = ${JSON.stringify(clip(text, 60))}${moved ? ' (into the focused overlay input)' : ''}${actual !== undefined && actual !== text ? ` (field now shows ${JSON.stringify(clip(actual, 60))})` : ''}${options.enter ? ' +Enter' : ''}`;
    });
  }

  /** Runs fn(element, arg) in the page and returns its JSON value; settles and prints a line only if the page changed. */
  async js(id: number, fn: string | ((el: Element, arg: never) => unknown), arg?: unknown) {
    const page = this.page();
    const before = await this.probe(page).catch(() => undefined);
    const done = await this.onLive(page, id, (i) =>
      this.onNode<unknown>(
        page,
        i,
        `async function(arg){const el=this.nodeType===1?this:this.parentElement;if(!el||!el.isConnected)throw Error('Target detached');return (${String(fn)})(el,arg);}`,
        arg,
      ),
    );
    const change = await this.change(before);
    if (change !== 'no change') {
      await this.settle();
      this.log(
        `[ok] js ${this.describe(done.id)}${done.note} -> ${await this.change(before)}${this.flushDialogs()}`,
      );
    }
    return done.value;
  }

  private async key(page: Page, key: string, keyCode: number, text?: string) {
    const k = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    if (text)
      await page.cdp('Input.dispatchKeyEvent', { type: 'char', ...k, text, unmodifiedText: text });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }
}
