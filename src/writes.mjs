import { load } from 'cheerio';
import { BASE } from './parsers.mjs';
import { ScombError } from './errors.mjs';
import { random, encrypt, decrypt, digest, equalSecret } from './crypto.mjs';
import { escape, htmlResponse, json } from './oauth.mjs';

const fail = (message) => {
  throw new ScombError('unsupported_write_form', message);
};
// Only native student submission forms, extracted from authenticated ScombZ HTML.
// No caller-supplied URL, script execution, redirects, or generic HTTP tool.
export function writeUrl(value, kind) {
  const u = new URL(value, BASE);
  const prefix =
    kind === 'assignment' ? '/lms/course/report/submission' : '/lms/course/examination/take';
  if (
    u.origin !== BASE ||
    u.username ||
    u.password ||
    u.hash ||
    !new RegExp('^' + prefix + '(?:[a-z_]*|/[a-z_]+)$', 'i').test(u.pathname)
  )
    fail('学生用の提出・解答経路を確認できません。原画面をご利用ください。');
  return u.href;
}
export function nativeForms(html, source, kind) {
  const $ = load(html),
    forms = [];
  $('form').each((_, node) => {
    const form = $(node);
    if ((form.attr('method') ?? '').toLowerCase() !== 'post' || !form.attr('action')) return;
    let action;
    try {
      action = writeUrl(new URL(form.attr('action'), source).href, kind);
    } catch {
      return;
    }
    if (
      form.attr('onsubmit') ||
      form.find(
        '[onclick],[onchange],[formaction],[formmethod],[form],.ql-editor,[contenteditable=true]',
      ).length
    )
      return;
    const fields = [],
      hidden = [],
      buttons = [];
    let unsupported = false;
    form.find('input,textarea,select,button').each((_, element) => {
      const el = $(element),
        name = el.attr('name'),
        tag = element.tagName;
      const type = (el.attr('type') ?? (tag === 'button' ? 'submit' : 'text')).toLowerCase();
      if (el.is('[disabled]')) return;
      if (type === 'submit') {
        buttons.push({
          name: name ?? '',
          value: el.attr('value') ?? '',
          label: el.text().trim() || el.attr('value') || '送信',
        });
        return;
      }
      if (!name) return;
      if (name.length > 200 || ['password', 'image', 'reset', 'button'].includes(type)) {
        unsupported = true;
        return;
      }
      const value = tag === 'textarea' ? el.text() : (el.attr('value') ?? '');
      if (type === 'hidden') {
        if (/answer|response|comment|reporttext|contenttext/i.test(name)) unsupported = true;
        hidden.push([name, value]);
        return;
      }
      const label =
        (el.attr('id')
          ? $('label')
              .filter((_, n) => $(n).attr('for') === el.attr('id'))
              .text()
          : '') ||
        el.closest('label').text() ||
        name;
      const options =
        tag === 'select'
          ? el
              .find('option')
              .map((_, o) => ({ value: $(o).attr('value') ?? $(o).text(), label: $(o).text() }))
              .get()
          : ['radio', 'checkbox'].includes(type)
            ? [{ value: el.attr('value') ?? 'on', label: label.trim() }]
            : undefined;
      fields.push({
        name,
        type: tag === 'select' ? 'select' : type,
        label: label.trim(),
        value,
        required: el.is('[required]'),
        multiple: el.is('[multiple]'),
        ...(options ? { options } : {}),
      });
    });
    if (unsupported || !buttons.length || fields.length > 200 || hidden.length > 200) return;
    forms.push({
      action,
      hidden,
      fields,
      buttons,
      context: form.text().replace(/\s+/g, ' ').trim().slice(0, 30000),
    });
  });
  return forms;
}
export function validateValues(form, values) {
  const result = [];
  for (const name of Object.keys(values)) {
    const controls = form.fields.filter((f) => f.name === name);
    if (!controls.length || controls.some((f) => f.type === 'file'))
      fail('未知の入力項目またはファイル項目です。');
    const list = Array.isArray(values[name]) ? values[name] : [values[name]];
    if (!list.every((v) => typeof v === 'string' && v.length <= 30000))
      fail('回答の形式を確認してください。');
    if (list.length > 1 && !controls.some((f) => f.multiple || f.type === 'checkbox'))
      fail('単一選択に複数の回答があります。');
    const choices = controls.flatMap((f) => f.options ?? []);
    for (const value of list) {
      if (choices.length && !choices.some((o) => o.value === value))
        fail('選択肢に存在しない回答です。');
      result.push([name, value]);
    }
  }
  for (const field of form.fields) {
    if (field.required && field.type !== 'file' && !result.some(([n, v]) => n === field.name && v))
      fail('必須の回答がありません。');
  }
  return result;
}
export async function writeForm(client, courseId, contentId, kind) {
  const course = await client.course(courseId);
  const item = course.contents.find((x) => x.kind === kind && x.content_id === contentId);
  if (!item) throw new ScombError('not_found', '科目一覧で提出先を確認できません。');
  const route = item.routes.find((x) =>
    new URL(x, BASE).pathname.endsWith(kind === 'assignment' ? '/submission' : '/taketop'),
  );
  if (!route) fail('現在利用できる提出画面がありません。');
  const source = new URL(route, BASE).href;
  const forms = nativeForms(await client.html(route), source, kind);
  if (!forms.length)
    fail(
      '標準HTMLの送信フォームがありません。JavaScript専用画面は実画面を調査するまで送信できません。',
    );
  return {
    course_id: courseId,
    content_id: contentId,
    kind,
    title: item.title ?? item.name ?? contentId,
    source_url: source,
    forms,
  };
}
export async function saveDraft(
  env,
  client,
  snapshot,
  formIndex,
  buttonIndex,
  values,
  origin,
  { allowIncomplete = false } = {},
) {
  const form = snapshot.forms[formIndex],
    button = form?.buttons[buttonIndex];
  if (!form || !button) fail('フォーム・送信ボタンを確認してください。');
  let entries,
    ready = true;
  try {
    entries = validateValues(form, values);
  } catch (error) {
    if (!allowIncomplete) throw error;
    entries = [];
    ready = false;
  }
  if (snapshot.pending_id) {
    const claimed = await env.DB.prepare(
      "UPDATE write_drafts SET state='superseded',data='' WHERE id=? AND state='pending'",
    )
      .bind(snapshot.pending_id)
      .run();
    if (claimed.meta.changes !== 1)
      throw new ScombError('draft_unavailable', '以前の確認内容は処理済みです。');
  }
  const session = await client.loadSession();
  const sessionHash = await digest(JSON.stringify(session.cookies));
  const id = random(),
    expires = Math.floor(Date.now() / 1000) + 600;
  const data = {
    ...snapshot,
    forms: undefined,
    form,
    button,
    entries,
    ready,
    sessionHash,
    authentication: client.authentication ?? null,
  };
  await env.DB.prepare('DELETE FROM write_drafts WHERE expires_at < ?')
    .bind(Math.floor(Date.now() / 1000))
    .run();
  await env.DB.prepare('INSERT INTO write_drafts(id,data,expires_at) VALUES(?,?,?)')
    .bind(id, await encrypt(env, JSON.stringify(data)), expires)
    .run();
  return {
    draft_id: id,
    status: 'awaiting_user_confirmation',
    confirmation_url: origin + '/write/' + id,
    expires_at: new Date(expires * 1000).toISOString(),
    target: snapshot.title,
    operation: button.label,
    answers: entries,
    files: form.fields
      .filter((f) => f.type === 'file')
      .map((f) => ({ name: f.name, label: f.label, required: f.required })),
    instruction:
      '提出先・回答・ファイルを本人が確認画面で確認し、管理キーを入力して承認するまで書き込みません。受験開始や次の確認画面も毎回別承認です。',
  };
}
export async function resumeDraft(env, client, id) {
  const { data } = await draft(env, id);
  const session = await client.loadSession();
  if (
    (client.authentication ?? null) !== data.authentication ||
    (await digest(JSON.stringify(session.cookies))) !== data.sessionHash
  )
    throw new ScombError('draft_stale', '認証状態が変わりました。');
  return { ...data, pending_id: id, forms: [data.form] };
}
export async function submissionStatus(env, client, id) {
  await client.loadSession();
  const row = await env.DB.prepare('SELECT state,expires_at,result FROM write_drafts WHERE id=?')
    .bind(id)
    .first();
  if (!row) throw new ScombError('not_found', '提出操作が見つかりません。');
  return {
    draft_id: id,
    status: row.state,
    expired: row.expires_at <= Date.now() / 1000,
    ...(row.result ? JSON.parse(await decrypt(env, row.result)) : {}),
  };
}
async function draft(env, id) {
  const row = await env.DB.prepare('SELECT * FROM write_drafts WHERE id=?').bind(id).first();
  if (!row || row.expires_at <= Date.now() / 1000 || row.state !== 'pending')
    throw new ScombError(
      'draft_unavailable',
      '確認の期限切れ、処理済み、または処理結果の確認が必要です。再送しないでください。',
    );
  return { row, data: JSON.parse(await decrypt(env, row.data)) };
}
export function confirmationPage(id) {
  // Draft contents require admin authentication; capability URLs alone reveal no answers.
  return htmlResponse(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>提出内容の確認</title><style>body{font:16px system-ui;color:#17324d;background:#f2f5f9;max-width:720px;margin:40px auto;padding:24px;line-height:1.7}form,pre{background:white;border:1px solid #d7e0ec;padding:20px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,input{font:inherit;margin:12px 0;padding:10px}button{display:block;background:#173e68;color:white;border:0;border-radius:6px}input[type=password]{width:90%}</style><h1>提出内容の確認</h1><p>管理キーを入力して内容を表示します。まだ送信しません。</p><form method="post" action="/write/${escape(id)}"><input type="password" name="admin_token" required autocomplete="off" aria-label="管理キー"><button name="step" value="review">内容を確認</button></form></html>`,
  );
}
export async function confirmWrite(request, env, client, id, origin) {
  if (request.headers.get('origin') !== origin)
    return json({ message: 'この確認画面から操作してください。' }, 403);
  // Stream-limit multipart data before parsing, including requests without Content-Length.
  if (Number(request.headers.get('content-length') ?? 0) > 16 * 1024 * 1024)
    return json({ message: '添付を含む送信上限は16MiBです。' }, 413);
  const reader = request.body?.getReader(),
    chunks = [];
  let size = 0;
  if (!reader) return json({ message: '入力が必要です。' }, 400);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16 * 1024 * 1024) {
      await reader.cancel();
      return json({ message: '添付を含む送信上限は16MiBです。' }, 413);
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.length;
  }
  const input = await new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
    body: buffer,
  }).formData();
  if (!(await equalSecret(input.get('admin_token'), env.ADMIN_TOKEN)))
    return json({ message: '管理キーを確認してください。' }, 401);
  const { row, data } = await draft(env, id);
  if (input.get('step') === 'review') {
    const fileInputs = data.form.fields
      .filter((f) => f.type === 'file')
      .map(
        (f, i) =>
          `<p><label>${escape(f.label)}<input type="file" name="attachment_${i}" ${f.required ? 'required' : ''} ${f.multiple ? 'multiple' : ''}></label></p>`,
      )
      .join('');
    return htmlResponse(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>送信前の最終確認</title><style>body{font:16px system-ui;color:#17324d;background:#f2f5f9;max-width:720px;margin:40px auto;padding:24px;line-height:1.7}form,pre{background:white;border:1px solid #d7e0ec;padding:20px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,input{font:inherit;margin:12px 0;padding:10px}button{display:block;background:#173e68;color:white;border:0;border-radius:6px}input[type=password]{width:90%}</style><h1>送信前の最終確認</h1><p>提出先: ${escape(data.title)} (${escape(data.course_id)})</p><p>操作: ${escape(data.button.label)}</p><p>元画面: ${escape(data.source_url)}</p><pre>${escape(data.form.context)}</pre><h2>今回送る回答</h2><pre>${escape(JSON.stringify(data.entries, null, 2))}</pre><p>受験開始・再受験は制限時間や受験回数に影響する場合があります。次の確認画面が返る場合は、そこでも再度承認が必要です。</p><form method="post" enctype="multipart/form-data" action="/write/${escape(id)}"><input type="hidden" name="admin_token" value="${escape(input.get('admin_token'))}">${fileInputs}<label><input type="checkbox" name="approved" value="yes" required>上記の提出先・回答と、選択した添付ファイルを確認しました</label><button name="step" value="commit">${escape(data.button.label)}を承認して送信</button></form></html>`,
    );
  }
  if (input.get('step') !== 'commit' || input.get('approved') !== 'yes')
    return json({ message: '内容の確認と明示的な承認が必要です。' }, 403);
  if (!data.ready)
    throw new ScombError(
      'answers_required',
      '問題への回答をprepare_submissionで準備してから、再度確認してください。',
    );
  await client.html('/portal/home');
  const session = await client.loadSession();
  if (
    (await digest(JSON.stringify(session.cookies))) !== data.sessionHash ||
    (client.authentication ?? null) !== data.authentication
  )
    throw new ScombError(
      'draft_stale',
      'ログイン状態が変わりました。提出内容を作り直して確認してください。',
    );
  validateValues(
    data.form,
    Object.fromEntries(
      [...new Set(data.entries.map(([n]) => n))].map((n) => [
        n,
        data.entries.filter(([key]) => key === n).map(([, v]) => v),
      ]),
    ),
  );
  const body = new FormData();
  for (const [name, value] of [...data.form.hidden, ...data.entries]) body.append(name, value);
  if (data.button.name) body.append(data.button.name, data.button.value);
  const files = data.form.fields.filter((f) => f.type === 'file');
  files.forEach((field, i) => {
    const selected = input
      .getAll('attachment_' + i)
      .filter((f) => typeof f !== 'string' && f.name && f.size);
    if (field.required && !selected.length) fail('必須ファイルがありません。');
    if (!field.multiple && selected.length > 1) fail('ファイル数を確認してください。');
    for (const file of selected) body.append(field.name, file, file.name);
  });
  // Atomic one-shot claim BEFORE sending. Network errors never unlock or auto-retry.
  const claimed = await env.DB.prepare(
    "UPDATE write_drafts SET state='sending' WHERE id=? AND state='pending' AND expires_at>?",
  )
    .bind(id, Math.floor(Date.now() / 1000))
    .run();
  if (claimed.meta.changes !== 1)
    throw new ScombError('draft_unavailable', '処理済みです。再送しないでください。');
  let response;
  try {
    response = await client.fetch(writeUrl(data.form.action, data.kind), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
      headers: {
        Cookie: session.cookies
          .filter(
            (c) =>
              (c.expires < 0 || c.expires > Date.now() / 1000) &&
              new URL(data.form.action).pathname.startsWith(c.path),
          )
          .map((c) => c.name + '=' + c.value)
          .join('; '),
        Origin: BASE,
        Referer: data.source_url,
      },
      body: files.length ? body : new URLSearchParams([...body]),
    });
  } catch {
    await env.DB.prepare("UPDATE write_drafts SET state='unknown',data='' WHERE id=?")
      .bind(id)
      .run();
    return json(
      {
        status: 'unknown',
        message:
          '通信が中断されました。送信済みの可能性があるため自動再送しません。ScombZで提出状況を確認してください。',
      },
      502,
    );
  }
  await env.DB.prepare("UPDATE write_drafts SET state='sent',data='' WHERE id=?").bind(id).run();
  if (!response.ok) {
    await response.body?.cancel();
    return json({
      status: 'verification_required',
      http_status: response.status,
      message: 'ScombZの原画面で提出状況を確認してください。自動リダイレクト・再送は行いません。',
    });
  }
  let text = '';
  try {
    const reader = response.body?.getReader();
    let length = 0;
    const parts = [];
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 3 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('oversize');
        }
        parts.push(value);
      }
    const bytes = new Uint8Array(length);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.length;
    }
    text = new TextDecoder().decode(bytes);
  } catch {
    return json({
      status: 'verification_required',
      message: '送信後の画面を確認できません。自動再送せず、ScombZで提出状況を確認してください。',
    });
  }
  const forms = nativeForms(text, data.form.action, data.kind);
  if (forms.length) {
    // Never advance or finalize a multi-step submission without another approval.
    const next = await saveDraft(
      env,
      client,
      { ...data, pending_id: undefined, source_url: data.form.action, forms },
      0,
      0,
      {},
      origin,
      { allowIncomplete: true },
    );
    await env.DB.prepare('UPDATE write_drafts SET result=? WHERE id=?')
      .bind(
        await encrypt(
          env,
          JSON.stringify({
            next,
            forms: forms.map(({ fields, buttons, context }) => ({ fields, buttons, context })),
          }),
        ),
        id,
      )
      .run();
    return json({
      status: 'next_confirmation_required',
      next,
      forms: forms.map(({ fields, buttons, context }) => ({ fields, buttons, context })),
      message: '次の画面への送信も別の承認が必要です。nextがない場合は原画面をご利用ください。',
    });
  }
  return json({
    status: 'verification_required',
    message:
      'ScombZに1回送信しました。HTTP成功だけで提出完了とは判定しません。課題状況・小テスト結果を原画面で確認してください。',
  });
}
