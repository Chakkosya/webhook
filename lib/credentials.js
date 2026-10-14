import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function createCredentialsCipher(value = process.env.CREDENTIALS_KEY) {
  if (value && !/^[a-f\d]{64}$/i.test(value)) throw new Error('CREDENTIALS_KEY 必须是 64 位十六进制密钥');
  const key = value ? Buffer.from(value, 'hex') : null;
  function requireKey() {
    if (!key) throw new Error('保存或读取下单凭证需要配置 CREDENTIALS_KEY');
  }
  return {
    encrypt(value, context) {
      requireKey();
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { encrypted: 'aes-256-gcm', version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    decrypt(value, context) {
      if (!value?.encrypted) return value;
      requireKey();
      try {
        if (value.encrypted !== 'aes-256-gcm' || value.version !== 1) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch { throw new Error('下单凭证无法解密，请检查 CREDENTIALS_KEY 和数据文件'); }
    }
  };
}

export function transformOrderSecrets(state, cipher, operation) {
  return { ...state, users: state.users.map(user => {
    const result = { ...user };
    for (const collection of ['orderAccounts', 'orderTasks']) {
      if (!Array.isArray(user[collection])) continue;
      result[collection] = user[collection].map(record => {
        const next = { ...record };
        for (const field of collection === 'orderAccounts' ? ['credentials', 'session'] : ['credentials']) {
          const value = record[field];
          if (value && Object.keys(value).length) next[field] = cipher[operation](value, JSON.stringify([user.id, collection, record.id || record.monitorId, field]));
        }
        return next;
      });
    }
    return result;
  }) };
}

export function requireCredentialHttps(request, env = process.env) {
  if (request.socket?.encrypted || env.TRUST_PROXY === '1' && request.headers['x-forwarded-proto'] === 'https') return;
  throw Object.assign(new Error('网站凭证录入必须通过 HTTPS 访问本应用'), { status: 403 });
}
