// 套餐使用官方客户端原名；未知标识原样显示，避免自行翻译或猜测档位。
export function planLabel(value) {
  const labels = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro 200',
    prolite: 'Pro 100',
    promax: 'Pro 500',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    apiKey: 'API Key',
    unknown: '套餐待确认',
  };
  return Object.hasOwn(labels, value) ? labels[value] : value || '套餐待确认';
}

// 自动生成的实例名称使用中文；用户自己填写的名称原样保留。
export function instanceLabel(instance, settings = {}) {
  if (settings.aliases?.[instance.home]) return instance.name;
  if (instance.name === '默认 Codex') return '默认实例';
  if (/^Codex [a-f\d]+$/i.test(instance.name || '')) return instance.name.replace(/^Codex /i, '实例 ');
  if (instance.name === 'Codex 实例') return '应用实例';
  return instance.name || '未命名实例';
}

// 技术来源标识只在界面转为用户可读的中文名称。
export function originLabel(origin) {
  return origin === 'Cockpit' ? '多开目录' : origin;
}
