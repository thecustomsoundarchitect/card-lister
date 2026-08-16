const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test('the primary batch action is labelled Submit', () => {
  assert.match(html, /<button id="export-btn">Submit<\/button>/);
  assert.doesNotMatch(html, /Tell Claude|Export to URL/);
});

test('phone source contains no service credentials', () => {
  assert.doesNotMatch(html, /X-Master-Key|JSONBIN_KEY|IMGBB_KEY/);
});

function buildHarness({
  responseOk,
  responseBody = { eventId: 'event-123', cardCount: 2, status: 'queued' },
  connection = { baseUrl: 'https://worker.example.test', token: 'phone secret' }
}) {
  const listeners = new Map();
  const elements = new Map();
  const alerts = [];
  const requests = [];
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
  if (connection) {
    storage.set('cardLister.connection.v1', JSON.stringify(connection));
  }

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
    fetch: async (url, options) => {
      requests.push({
        url,
        headers: options.headers,
        body: JSON.parse(options.body)
      });
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
    getRequests: () => requests,
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

  const request = harness.getRequests()[0];
  assert.equal(request.url, 'https://worker.example.test/v1/submissions');
  assert.equal(request.headers.Authorization, 'Bearer phone secret');
  assert.equal(request.body.cards.length, 2);
  assert.deepEqual(harness.getSavedState(), {
    batch: 'A12',
    cards: [],
    current: { photos: [] }
  });
  assert.equal(
    harness.elements.get('overlay-msg').textContent,
    'Batch stored safely. Event event-123 is queued for processing. Receipt sent for 2 cards.'
  );
});

test('stored receipt clears the batch and reports durable storage', async () => {
  const harness = buildHarness({
    responseOk: true,
    responseBody: { eventId: 'event-123', cardCount: 2, status: 'stored' }
  });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 0);
  assert.equal(harness.getSavedState().current.photos.length, 0);
  assert.equal(
    harness.elements.get('overlay-msg').textContent,
    'Batch stored safely. Event event-123 is waiting for processing. Receipt sent for 2 cards.'
  );
});

test('malformed stored receipt preserves every card and photograph', async () => {
  const harness = buildHarness({ responseOk: true, responseBody: { status: 'stored' } });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 2);
  assert.equal(harness.getSavedState().current.photos.length, 1);
  assert.match(harness.alerts[0], /Submit failed: Invalid submit receipt/);
});

test('stored batch reports a pending email without restoring cleared cards', async () => {
  const harness = buildHarness({
    responseOk: true,
    responseBody: {
      eventId: 'event-123',
      cardCount: 2,
      status: 'queued',
      receiptEmail: 'pending'
    }
  });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 0);
  assert.match(harness.elements.get('overlay-msg').textContent, /Email receipt is pending/);
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

  const [firstRequest, secondRequest] = harness.getRequests();
  const firstBatch = firstRequest.body;
  const secondBatch = secondRequest.body;
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

test('missing secure connection preserves every saved card and photograph', async () => {
  const harness = buildHarness({ responseOk: true, connection: null });

  await harness.export();

  assert.equal(harness.getSavedState().cards.length, 2);
  assert.equal(harness.getSavedState().current.photos.length, 1);
  assert.match(harness.alerts[0], /Phone connection is not configured/);
  assert.equal(harness.getRequests().length, 0);
});
