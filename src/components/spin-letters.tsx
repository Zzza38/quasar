'use client';

import { useEffect } from 'react';

type TextRun = { original: string; wrapper: HTMLSpanElement };
// Letters the I'm Shy mod already split keep its wrappers; the Spin stylesheet rotates those glyphs too.
const EXCLUDED = 'script, style, noscript, textarea, input, [contenteditable], [role="textbox"], .sr-only, [data-spin-text], [data-shy-text], svg, img, video, canvas';

/** Wraps every visible grapheme in its own inline-block span so the Spin stylesheet can rotate each letter. */
export function SpinLetters() {
  useEffect(() => {
    const runs = new Map<Text, TextRun>();
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    // Text nodes the page wrote to since the last split. Spin's own placeholder writes happen while the observer is off.
    const rewritten = new Set<Text>();
    let frame = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) if (record.type === 'characterData' && runs.has(record.target as Text)) rewritten.add(record.target as Text);
      if (!frame) frame = requestAnimationFrame(split);
    });
    const observe = () => observer.observe(document.body, { childList: true, characterData: true, subtree: true });

    function split() {
      frame = 0;
      observer.disconnect();
      // React keeps writing to its original Text node. A rewritten node is split again below, even when the page
      // cleared it to an empty string; only Spin's own placeholder is restored when its wrapper went missing.
      for (const [node, run] of runs) {
        if (rewritten.has(node) || !node.isConnected || !run.wrapper.isConnected || node.data) {
          if (node.isConnected && !node.data && !rewritten.has(node)) node.data = run.original;
          run.wrapper.remove();
          runs.delete(node);
        }
      }
      rewritten.clear();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement && !node.parentElement.closest(EXCLUDED)) nodes.push(node as Text);
      }
      for (const node of nodes) {
        const original = node.data;
        const wrapper = document.createElement('span');
        wrapper.dataset.spinText = '';
        // One named visual per run keeps control names whole for assistive technology.
        wrapper.setAttribute('role', 'img');
        wrapper.setAttribute('aria-label', original);
        for (const word of original.split(/(\s+)/)) {
          if (!word) continue;
          if (/^\s+$/.test(word)) { wrapper.append(document.createTextNode(word)); continue; }
          const group = document.createElement('span');
          group.style.whiteSpace = 'nowrap';
          for (const { segment } of segmenter.segment(word)) {
            const glyph = document.createElement('span');
            glyph.dataset.spinGlyph = '';
            glyph.setAttribute('aria-hidden', 'true');
            glyph.textContent = segment;
            group.append(glyph);
          }
          wrapper.append(group);
        }
        node.after(wrapper);
        node.data = '';
        runs.set(node, { original, wrapper });
      }
      observe();
    }

    split();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const [node, run] of runs) { if (node.isConnected && !node.data && !rewritten.has(node)) node.data = run.original; run.wrapper.remove(); }
    };
  }, []);
  return null;
}
