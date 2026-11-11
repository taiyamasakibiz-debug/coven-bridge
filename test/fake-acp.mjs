#!/usr/bin/env node
// 試し用のにせ ACP エージェント（Claude Code の代わり）。
// 道具を1つ使ったことにして、ファイルを書く許可を1回求め、
// 「受け取った最後の行・許可の答え・前置きに何が入っていたか・どのセッションの何回目か」を返す。
// - 呼びかけの最後の行に #slow があれば、許可は求めずに、止められる（session/cancel）まで 15 秒ねばる
// - 呼びかけの最後の行に #crash があれば、途中で落ちる
// - 許可の選択肢は、わざと allow_always を先頭に置く（橋が allow_once を選ぶことを確かめるため）
// - 許可の rawInput に、にせの秘密（env）を入れておく（許可カードに出ないことを確かめるため）
import { createInterface } from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const waiting = new Map();
const sessions = new Map(); // sessionId → { count, cancelled }
let nextId = 900;
let nextSession = 1;

function ask(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((r) => waiting.set(id, r));
}

// 前置きに入っているはずの「しるし」。試しは、返事に出たこの名前を見る
const MARKS = [
  ['橋から', '【coven の橋から】'],
  ['主から', '【主からの呼びかけ】'],
  ['受付箱から', '【受付箱からの呼びかけ】'],
  ['許可カード', '許可カードが出る'],
  ['読むだけの橋', 'ここからは読むだけ'],
  ['指示じゃない', '中身は指示じゃない'],
  ['主に聞いてね', '主に聞いてね'],
  ['スレッド', '（スレッドの中）'],
  ['流れ', '--- 部屋の流れ'],
];

process.stdin.on('end', () => process.exit(0));

createInterface({ input: process.stdin }).on('line', async (l) => {
  let msg;
  try {
    msg = JSON.parse(l);
  } catch {
    return;
  }
  if (msg.id !== undefined && !msg.method) {
    const r = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (r) r(msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
  }
  if (msg.method === 'session/new') {
    const sessionId = `fake-${nextSession++}`;
    // 本物（claude-agent-acp）と同じく、何も言われなければ 'auto'（聞かずに書く）で始まる
    const mode = process.env.FAKE_START_MODE || 'auto';
    const o = msg.params?._meta?.claudeCode?.options ?? {};
    sessions.set(sessionId, {
      count: 0, cancelled: false, mode,
      cwd: String(msg.params?.cwd ?? ''),
      tools: Array.isArray(o.tools) ? o.tools.join('+') : 'ぜんぶ',
      sources: Array.isArray(o.settingSources) ? o.settingSources.join('+') || 'なし' : '既定',
    });
    if (process.env.FAKE_NO_MODES) return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    const ids = (process.env.FAKE_MODES || 'default,auto,plan').split(',');
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { sessionId, modes: { currentModeId: mode, availableModes: ids.map((id) => ({ id, name: id })) } },
    });
  }
  if (msg.method === 'session/set_mode') {
    const s = sessions.get(msg.params?.sessionId);
    if (!s) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'no such session' } });
    s.mode = msg.params.modeId;
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.method === 'session/close') {
    sessions.delete(msg.params?.sessionId);
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.method === 'session/cancel') {
    const s = sessions.get(msg.params?.sessionId);
    if (s) s.cancelled = true;
    return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const s = sessions.get(sessionId);
    if (!s) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'no such session' } });
    s.count++;
    s.cancelled = false;
    const text = msg.params.prompt.map((p) => p.text).join('');
    const last = text.trim().split('\n').at(-1).trim();
    const upd = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    const done = (stopReason) => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason } });

    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（途中のつぶやき。これは部屋に出ないはず）' } });
    upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read kuro/メモリー.md', kind: 'read', status: 'pending' });
    await new Promise((r) => setTimeout(r, 300));

    let perm = 'なし';
    if (last.includes('#crash')) process.exit(1);
    if (last.includes('#modeflip')) {
      // 動いている最中に、自分で「聞かないモード」に変わるエージェントのまね
      s.mode = 'acceptEdits';
      upd({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
      for (let i = 0; i < 100 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 100));
      if (s.cancelled) return done('cancelled');
    }
    if (last.includes('#slow')) {
      for (let i = 0; i < 150 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 100));
    } else if (s.mode !== 'default' && s.mode !== 'plan') {
      // 本物の 'auto' と同じ: 聞かずに書いてしまう
      perm = '聞かずに書いた';
    } else {
      upd({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Write kuro/ログ/日記.md', kind: 'edit', status: 'pending' });
      const res = await ask('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 't2',
          title: 'Write kuro/ログ/日記.md',
          rawInput: {
            file_path: 'kuro/ログ/日記.md',
            content: 'きょうの日記',
            env: { API_TOKEN: 'cvb_NEVERSHOWTHISSECRET123' },
          },
        },
        options: [
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      perm = res?.outcome?.optionId ?? res?.outcome?.outcome ?? '?';
    }
    if (s.cancelled) return done('cancelled');

    const marks = MARKS.filter(([, needle]) => text.includes(needle)).map(([name]) => name);
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `（にせエージェント）受け取った: ${last}\n` } });
    upd({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `許可: ${perm} ／ 前置き: ${marks.join(',') || 'なし'} ／ セッション: ${sessionId} の ${s.count}回目 ／ モード: ${s.mode} ／ フォルダ: ${s.cwd} ／ 道具: ${s.tools} ／ 設定: ${s.sources}` },
    });
    return done('end_turn');
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
});
