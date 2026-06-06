// Bundle entry for the renderer's editor module. esbuild rolls CodeMirror's
// bare specifiers into a single ESM file that index.html can load.
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { tags as t } from '@lezer/highlight';

// Postie's dark palette, spelled in HighlightStyle terms.
const postieHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#ff7a45' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#5b9bff' },
  { tag: [t.function(t.variableName), t.labelName], color: '#5b9bff' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#ffa372' },
  { tag: [t.definition(t.name), t.separator], color: '#e6e7ea' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#e3b341' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#ff7a45' },
  { tag: [t.meta, t.comment], color: '#9ba0a6', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#5b9bff', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: '#5b9bff' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#4caf78' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#4caf78' },
  { tag: t.invalid, color: '#ef6b6b' },
  { tag: t.tagName, color: '#ff7a45' },
  { tag: t.attributeName, color: '#5b9bff' },
  { tag: t.attributeValue, color: '#4caf78' },
]);

const baseTheme = EditorView.theme({
  // Base color goes on `&` (the .cm-editor root) so the syntax-highlight
  // classes (which are bare class selectors of specificity 0,1,0) still
  // win over the cascade. Putting color on `.cm-content` would defeat them.
  '&': {
    color: '#e6e7ea',
    backgroundColor: '#2f3136',
    height: '100%',
    fontSize: '12px',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    caretColor: '#ff7a45',
    padding: '8px 0',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    overflow: 'auto',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ff7a45' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(255, 122, 69, 0.25)',
  },
  '.cm-gutters': {
    backgroundColor: '#282a2e',
    color: '#9ba0a6',
    border: 'none',
    borderRight: '1px solid #3a3d42',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 122, 69, 0.08)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 122, 69, 0.04)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(255, 122, 69, 0.2)',
    outline: '1px solid #ff7a45',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#9ba0a6',
  },
});

function languageFor(kind) {
  if (kind === 'json') return json();
  if (kind === 'xml') return xml();
  if (kind === 'html') return html();
  if (kind === 'javascript') return javascript();
  return [];
}

// Mounts a CodeMirror editor into `parent`. Returns a small handle that hides
// CM6 internals from the rest of the app.
export function createEditor({ parent, doc = '', language = 'none', readOnly = false, onChange }) {
  const langCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) onChange(update.state.doc.toString());
  });

  const extensions = [
    lineNumbers(),
    foldGutter(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    syntaxHighlighting(postieHighlight),
    baseTheme,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    langCompartment.of(languageFor(language)),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    updateListener,
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text ?? '' },
      });
    },
    setLanguage: (kind) => {
      view.dispatch({ effects: langCompartment.reconfigure(languageFor(kind)) });
    },
    setReadOnly: (ro) => {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
