import assert from 'node:assert/strict'
import test from 'node:test'
import { LANGUAGE_FALLBACK, defaultLanguage, initialLanguage } from '../client-src/lib/language.js'

test('默认语种跟随后端给的 default_language', () => {
  assert.equal(LANGUAGE_FALLBACK, 'Chinese')
  assert.equal(defaultLanguage({ default_language: 'English' }), 'English')
  assert.equal(defaultLanguage({}), 'Chinese')
  assert.equal(defaultLanguage(null), 'Chinese')
})

test('记录里已有语种时保留记录，空的才用默认值', () => {
  assert.equal(initialLanguage('auto', { default_language: 'Chinese' }), 'auto')
  assert.equal(initialLanguage('English', { default_language: 'Chinese' }), 'English')
  assert.equal(initialLanguage('', { default_language: 'English' }), 'English')
  assert.equal(initialLanguage(null, null), 'Chinese')
})
