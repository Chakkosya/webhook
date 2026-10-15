import { randomUUID } from 'node:crypto';

export function initializeAiKeys(settings) {
  if (!Array.isArray(settings.aiKeys)) {
    settings.aiKeys = settings.aiKey ? [{ id: randomUUID(), name: '默认 API Key', key: settings.aiKey }] : [];
  }
  const active = settings.aiKeys.find(item => item.id === settings.activeAiKeyId) || settings.aiKeys[0];
  settings.activeAiKeyId = active?.id || null;
  settings.aiKey = active?.key || '';
}

export function publicAiKeys(settings) {
  return settings.aiKeys.map(({ id, name, key }) => ({ id, name, hasKey: Boolean(key) }));
}

export function selectedAiKey(settings, id = settings.activeAiKeyId) {
  const item = settings.aiKeys.find(item => item.id === id);
  if (!item) throw new Error('所选 API Key 已不存在，请重新选择');
  return item.key;
}

export function aiKeysFromInput(settings, input) {
  let aiKeys = settings.aiKeys;
  if (input.aiKeys !== undefined) {
    if (!Array.isArray(input.aiKeys)) throw new Error('API Key 列表格式不正确');
    const ids = new Set();
    aiKeys = input.aiKeys.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('API Key 条目格式不正确');
      const id = String(item.id || randomUUID());
      if (ids.has(id)) throw new Error('API Key 条目不能重复');
      ids.add(id);
      const name = String(item.name || '').trim() || `API Key ${index + 1}`;
      if (!name || name.length > 80) throw new Error('API Key 名称需要 1–80 个字符');
      const key = String(item.key || '').trim() || settings.aiKeys.find(saved => saved.id === id)?.key || '';
      if (!key) throw new Error('新增 API Key 时请填写密钥');
      if (key.length > 500) throw new Error('API Key 过长');
      return { id, name, key };
    });
  }
  const requestedId = input.activeAiKeyId === undefined ? settings.activeAiKeyId : input.activeAiKeyId;
  if (input.activeAiKeyId && !aiKeys.some(item => item.id === requestedId)) throw new Error('所选 API Key 已不存在，请重新选择');
  let active = aiKeys.find(item => item.id === requestedId) || aiKeys[0];
  const key = String(input.aiKey || '').trim().slice(0, 500);
  if (key) {
    active = active ? { ...active, key } : { id: randomUUID(), name: '默认 API Key', key };
    aiKeys = aiKeys.some(item => item.id === active.id) ? aiKeys.map(item => item.id === active.id ? active : item) : [...aiKeys, active];
  }
  return { aiKeys, activeAiKeyId: active?.id || null, aiKey: active?.key || '' };
}

export function removeActiveAiKey(settings) {
  const aiKeys = settings.aiKeys.filter(item => item.id !== settings.activeAiKeyId);
  return { aiKeys, activeAiKeyId: aiKeys[0]?.id || null, aiKey: aiKeys[0]?.key || '' };
}
