const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

function buildHarness({ responseOk, responseBody = { eventId: 'event-123', cardCount: 2, status: 'queued' } }) {
  const listeners = new Map();
  const elements = new Map();
  const alerts = [];
  const requestBodies = [];
  let dateSequence = 0;

  class SequenceDate extends Date {
    constructor(...args) {
      if (args.length > 0) {
        super(...args);
        return;
      }
      super(1723723200000 + dateSequence);
      dateSequence += 1;
    }
  }

  const initialState = {
    batch: 'A12',
    cards: [
      { id: 1, location: 'A12', timestamp: 'one', photos: [{ type: 'front', url: 'https://example.com/one.jpg' }] },
      { id: 2, location: 'A12', timestamp: 'two', photos: [{ type: 'back', url: 'https://example.com/two.jpg' }] }
    ],
    current: { photos: [{ type: 'extra', url: 'https://example.com/extra.jpg' }] }
  };

  const storage = new Map([['cardLister.v1', JSON.stringify(initialState)]]);

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener(type, handler) {
          listeners.set(`${id}:${type}`, handler);
        },
        appendChild() {},
        classList: {
          add() {},
          remove() {},
          toggle() {}
        },
        click() {},
        disabled: false,
        files: [],
        innerHTML: '',
        style: {},
        textContent: '',
        value: ''
      });
    }
    return elements.get(id);
  }

  const context = vm.createContext({
    alert(message) {
      alerts.push(message);
    },
    confirm() {
      return true;
    },
    console,
    document: {
      createElement() {
        return element(`created:${elements.size}`);
      },
      getElementById: element
    },
    Date: SequenceDate,
    fetch: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: responseOk,
        status: 503,
        json: async () => responseBody
      };
    },
    localStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      }
    },
    navigator: {
      clipboard: {
        writeText: async () => {}
      }
    },
    prompt() {
      return null;
    },
    setTimeout
  });

  vm.runInContext(scripts.join('\n'), context);

  return {
    alerts,
    done: listeners.get('done-btn:click'),
    elements,
    export: listeners.get('export-btn:click'),
    getRequestBodies: () => requestBodies,
    setCurrentPhotos(photos) {
      context.__nextPhotos = photos;
      vm.runInContext('state.current = { photos: __nextPhotos }; save();', context);
    },
    getSavedState: () => JSON.parse(storage.get('cardLister.v1'))
  };
}

test('successful export clears the submitted batch after sending it', async () => {
  const harness = buildHarness({ responseOk: true });

  await harness.export();

  assert.equal(harness.getRequestBodies()[0].cards.length, 2);
  assert.deepEqual(harness.getSavedState(), {
    batch: 'A12',
    cards: [],
    current: { photos: [] }
  });
  assert.equal(
    harness.elements.get('overlay-msg').textContent,
    'Batch stored. Event event-123 is queued for processing. Receipt sent for 2 cards.'
  );
});

test('successful export requires a queued event receipt before clearing', async () => {
  const harness = buildHarness({ responseOk: true, responseBody: { status: 'stored' } });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 2);
  assert.equal(harness.getSavedState().current.photos.length, 1);
  assert.match(harness.alerts[0], /Submit failed: Invalid submit receipt/);
});

test('the next submitted batch contains only its new cards and a new export time', async () => {
  const harness = buildHarness({ responseOk: true });

  await harness.export();
  harness.setCurrentPhotos([
    { type: 'front', url: 'https://example.com/new-front.jpg' },
    { type: 'back', url: 'https://example.com/new-back.jpg' }
  ]);
  harness.done();
  await harness.export();

  const [firstBatch, secondBatch] = harness.getRequestBodies();
  assert.notEqual(firstBatch.exportedAt, secondBatch.exportedAt);
  assert.equal(secondBatch.cards.length, 1);
  assert.equal(secondBatch.cards[0].id, 1);
  assert.equal(secondBatch.cards[0].photos[0].url, 'https://example.com/new-front.jpg');
});

test('failed export preserves every saved card and photograph', async () => {
  const harness = buildHarness({ responseOk: false });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 2);
  assert.equal(harness.getSavedState().current.photos.length, 1);
  assert.match(harness.alerts[0], /^Submit failed:/);
});
