// 转写语种：没有单独选语种的记录跟随设置里的默认值（后端默认中文）。
export const LANGUAGE_FALLBACK = 'Chinese'

export function defaultLanguage(options) {
  return options?.default_language || LANGUAGE_FALLBACK
}

export function initialLanguage(hint, options) {
  return hint || defaultLanguage(options)
}
