import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateVisualReply,
  isModelRejection,
} from './heqa-putri-image-steer.mjs'

test('accepts only the exact deterministic visual fact', () => {
  assert.deepEqual(evaluateVisualReply('All Fix By Putri', 'All Fix By Putri'), {
    valid: true,
    failureCode: null,
  })
  assert.deepEqual(evaluateVisualReply('The heading says All Fix By Putri.', 'All Fix By Putri'), {
    valid: false,
    failureCode: 'VISUAL_FACT_MISMATCH',
  })
})

test('rejects the former false-positive model rejection sentence', () => {
  const reply = 'The current model does not support images; switch to a model that does'

  assert.equal(isModelRejection(reply), true)
  assert.deepEqual(evaluateVisualReply(reply, reply), {
    valid: false,
    failureCode: 'VISUAL_MODEL_REJECTION',
  })
})

test('rejects paraphrased image capability failures', () => {
  assert.deepEqual(
    evaluateVisualReply('I am unable to inspect the attached screenshot.', 'All Fix By Putri'),
    { valid: false, failureCode: 'VISUAL_MODEL_REJECTION' },
  )
  assert.deepEqual(
    evaluateVisualReply('Vision capability is unavailable.', 'All Fix By Putri'),
    { valid: false, failureCode: 'VISUAL_MODEL_REJECTION' },
  )
})
