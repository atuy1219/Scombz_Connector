import { load } from 'cheerio';
import { BASE } from './parsers.mjs';
import { ScombError } from './errors.mjs';
import { random, encrypt, decrypt, digest, equalSecret } from './crypto.mjs';
import { escape, htmlResponse, json } from './oauth.mjs';
import { submissionForms } from './submission-adapters.mjs';
import { surveyReceipt, verifySurvey } from './survey-completion.mjs';

const fail = (message) => {
  throw new ScombError('unsupported_write_form', message);
};
// Only native student submission forms, extracted from authenticated ScombZ HTML.
// No caller-supplied URL, script execution, redirects, or generic HTTP tool.
export function writeUrl(value, kind) {
  const u = new URL(value, BASE);
  const paths = {
    assignment: ['/lms/course/report/upload', '/lms/course/report/submission'],
    quiz: ['/lms/course/examination/take'],
    survey: ['/lms/course/surveys/take', '/portal/surveys/take'],
  };
  if (
    u.origin !== BASE ||
    u.username ||
    u.password ||
    u.hash ||
    !paths[kind]?.includes(u.pathname) ||
    (u.search &&
      !(
        kind === 'quiz' &&
        u.pathname === '/lms/course/examination/take' &&
        u.search === '?confirm'
      ) &&
      (u.pathname !== '/lms/course/report/upload' ||
        [...u.searchParams.keys()].length !== 1 ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get('_cid') ?? '')))
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
        if (
          /answer|response|comment|reporttext|contenttext/i.test(name) &&
          !/^!?answerDetail\[\d+\]\.(?:surveyNo(?:Sub)?|answerItem\[\d+\]\.answer)$/.test(name) &&
          !/^answer\[\d+\]\.examinationNo$/.test(name) &&
          !/^!answer\[\d+\]\.answerItem\[\d+\]\.answer$/.test(name) &&
          !['answerStatus', 'reanswerFlag'].includes(name)
        )
          unsupported = true;
        // Actual answers hidden on a final page cannot be silently replayed.
        if (/^answerDetail.*\.answer$/.test(name)) unsupported = true;
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
        el.closest('.surveys-contents-quetison-area').find('.break').text() ||
        (el.closest('.survey-question-table-line').length
          ? el.closest('.survey-question-table-line').children('.break').first().text() +
            ' / ' +
            el
              .closest('.survey-question-table')
              .find('.survey-question-table-line')
              .first()
              .children()
              .eq(Number(name.match(/answerItem\[(\d+)\]/)?.[1]) + 1)
              .text()
          : '') ||
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
  for (const group of form.required_groups ?? [])
    if (!result.some(([n, v]) => group.includes(n) && v)) fail('必須の設問に回答がありません。');
  for (const [name, value] of result)
    if (name === 'creationTime' && !/^\d{1,6}$/.test(value))
      fail('作成時間は0以上の整数（分）です。');
  return result;
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
  await env.DB.prepare('INSERT INTO write_drafts(id,data,expires_at,owner) VALUES(?,?,?,?)')
    .bind(
      id,
      await encrypt(env, JSON.stringify(data)),
      expires,
      client.authentication ?? sessionHash,
    )
    .run();
  return {
    draft_id: id,
    status: 'awaiting_user_confirmation',
    confirmation_url: origin + '/write/' + id,
    expires_at: new Date(expires * 1000).toISOString(),
    target: snapshot.title,
    operation: button.label,
    answers: entries,
    ...(form.expected_summary ? { confirmed_answers: form.expected_summary } : {}),
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
  const session = await client.loadSession();
  const row = await env.DB.prepare(
    'SELECT state,expires_at,result,owner FROM write_drafts WHERE id=?',
  )
    .bind(id)
    .first();
  if (
    !row ||
    row.owner !== (client.authentication ?? (await digest(JSON.stringify(session.cookies))))
  )
    throw new ScombError('not_found', '本人の提出操作が見つかりません。');
  let result = row.result ? JSON.parse(await decrypt(env, row.result)) : {};
  if (result.verification && result.status !== 'completed') {
    result = { ...result, ...(await verifySurvey(client, result.verification)) };
    const changed = await env.DB.prepare('UPDATE write_drafts SET result=? WHERE id=? AND result=?')
      .bind(await encrypt(env, JSON.stringify(result)), id, row.result)
      .run();
    if (changed.meta.changes !== 1) {
      const latest = await env.DB.prepare('SELECT result FROM write_drafts WHERE id=?')
        .bind(id)
        .first();
      if (!latest) throw new ScombError('not_found', '本人の提出操作が見つかりません。');
      result = latest.result ? JSON.parse(await decrypt(env, latest.result)) : {};
    }
  }
  const { verification, ...publicResult } = result;
  return {
    draft_id: id,
    status: row.state,
    expired: row.expires_at <= Date.now() / 1000,
    ...publicResult,
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
      `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>送信前の最終確認</title><style>body{font:16px system-ui;color:#17324d;background:#f2f5f9;max-width:720px;margin:40px auto;padding:24px;line-height:1.7}form,pre{background:white;border:1px solid #d7e0ec;padding:20px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,input{font:inherit;margin:12px 0;padding:10px}button{display:block;background:#173e68;color:white;border:0;border-radius:6px}input[type=password]{width:90%}</style><h1>送信前の最終確認</h1><p>提出先: ${escape(data.title)} (${escape(data.course_id)})</p><p>操作: ${escape(data.button.label)}</p><p>元画面: ${escape(data.source_url)}</p><pre>${escape(data.form.context)}</pre><h2>今回送る回答</h2><pre>${escape(JSON.stringify(data.form.expected_summary ?? data.entries, null, 2))}</pre><p>受験開始・再受験は制限時間や受験回数に影響する場合があります。次の確認画面が返る場合は、そこでも再度承認が必要です。</p><form method="post" enctype="multipart/form-data" action="/write/${escape(id)}"><input type="hidden" name="admin_token" value="${escape(input.get('admin_token'))}">${fileInputs}<label><input type="checkbox" name="approved" value="yes" required>上記の提出先・回答と、選択した添付ファイルを確認しました</label><button name="step" value="commit">${escape(data.button.label)}を承認して送信</button></form></html>`,
    );
  }
  if (input.get('step') !== 'commit' || input.get('approved') !== 'yes')
    return json({ message: '内容の確認と明示的な承認が必要です。' }, 403);
  if (!data.ready)
    throw new ScombError(
      'answers_required',
      '専用の回答準備ツールで今回の回答を設定してから、再度確認してください。',
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
  const uploaded = [];
  files.forEach((field, i) => {
    const selected = input
      .getAll('attachment_' + i)
      .filter((f) => typeof f !== 'string' && f.name && f.size);
    if (field.required && !selected.length) fail('必須ファイルがありません。');
    if (!field.multiple && selected.length > 1) fail('ファイル数を確認してください。');
    if (selected.length > 30) fail('添付は30個までです。');
    for (const file of selected) {
      if (!file.name || /[\r\n]/.test(file.name)) fail('ファイル名を確認してください。');
      body.append(field.name, file, file.name);
      if (data.form.phase === 'assignment_upload') {
        const metadata = data.form.file_template.map(([name, value]) => [
          name,
          name === 'originalFileName' ? file.name : value,
        ]);
        for (const [name, value] of metadata) body.append(name, value);
        uploaded.push({ name: file.name, bytes: file.size, metadata });
      }
    }
  });
  const verification =
    data.form.phase === 'survey_final'
      ? {
          kind: 'survey',
          course_id: data.course_id,
          content_id: data.content_id,
          expected: data.form.expected_summary,
          before: await surveyReceipt(client, data),
          started_at: Date.now(),
        }
      : null;
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
              c.domain === new URL(BASE).hostname &&
              (c.expires < 0 || c.expires > Date.now() / 1000) &&
              (new URL(data.form.action).pathname === c.path ||
                new URL(data.form.action).pathname.startsWith(
                  c.path.endsWith('/') ? c.path : c.path + '/',
                )),
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
    if (verification) return finishSurvey(env, client, id, verification, { transport: 'unknown' });
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
  if (verification) {
    try {
      await response.body?.cancel();
    } catch {}
    return finishSurvey(env, client, id, verification, { http_status: response.status });
  }
  if (!response.ok) {
    await response.body?.cancel();
    const result = {
      status: 'verification_required',
      http_status: response.status,
      message: 'ScombZの原画面で提出状況を確認してください。自動リダイレクト・再送は行いません。',
    };
    await recordResult(env, id, result);
    return json(result);
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
    const result = {
      status: 'verification_required',
      message: '送信後の画面を確認できません。自動再送せず、ScombZで提出状況を確認してください。',
    };
    await recordResult(env, id, result);
    return json(result);
  }
  let forms = [];
  let limitation = null;
  if (data.form.phase === 'assignment_upload') {
    let ids;
    try {
      ids = JSON.parse(text);
    } catch {}
    if (
      !Array.isArray(ids) ||
      ids.length !== uploaded.length ||
      !ids.every((x) => /^(?:[1-9]\d*)$/.test(String(x)))
    ) {
      const result = {
        status: 'verification_required',
        message: 'アップロード結果を確認できません。確認画面への送信・自動再送は行いません。',
      };
      await recordResult(env, id, result);
      return json(result);
    }
    const metadata = uploaded.flatMap((f, i) =>
      f.metadata.map(([n, v]) => [
        n,
        n === 'fileId'
          ? String(ids[i])
          : ['originalFileName', 'fileName', 'comment'].includes(n)
            ? v.replaceAll(',', '&sbquo;')
            : v,
      ]),
    );
    forms = [
      {
        action: BASE + '/lms/course/report/submission',
        phase: 'assignment_preview',
        hidden: [...data.form.hidden, ...data.entries, ...metadata],
        fields: [],
        buttons: [{ name: '', value: '', label: '課題の確認画面へ進む（まだ最終提出しない）' }],
        context:
          '今回の回答: ' +
          JSON.stringify(data.entries) +
          '\nアップロード済み添付: ' +
          JSON.stringify(uploaded.map(({ name, bytes }) => ({ name, bytes }))),
      },
    ];
  } else {
    try {
      forms = submissionForms(text, data.form.action, data, 'continuation');
    } catch (error) {
      limitation =
        error.code === 'unsupported_write_form'
          ? error.message
          : '送信後の画面形式を確認できません。';
    }
  }
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
    const result = {
      status: 'next_confirmation_required',
      next,
      forms: forms.map(({ fields, buttons, context, phase }) => ({
        fields,
        buttons,
        context,
        phase,
      })),
      message: '次の画面への送信も別の承認が必要です。nextがない場合は原画面をご利用ください。',
    };
    await recordResult(env, id, result);
    return json(result);
  }
  const result = {
    status: 'verification_required',
    limitation,
    message:
      'ScombZに1回送信しました。HTTP成功だけで提出完了とは判定しません。課題状況・小テスト結果を原画面で確認してください。',
  };
  await recordResult(env, id, result);
  return json(result);
}
async function recordResult(env, id, result) {
  await env.DB.prepare('UPDATE write_drafts SET result=? WHERE id=?')
    .bind(await encrypt(env, JSON.stringify(result)), id)
    .run();
}
async function finishSurvey(env, client, id, verification, transport) {
  const verified = await verifySurvey(client, verification);
  const result = { ...transport, ...verified, verification };
  await recordResult(env, id, result);
  return json({ ...transport, ...verified });
}
