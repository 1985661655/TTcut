# Configurable Inference Batch Design

## Goal

Let users select a TrackNet inference batch size of 4, 8, 12, or 16 from Settings. Apple Silicon defaults to 8, other platforms retain the current default of 4, and accelerator out-of-memory failures automatically retry with smaller batches without restarting the video analysis.

The optimization must not change model weights, preprocessing, postprocessing, frame ordering, or rally detection behavior.

## Settings and migration

- Add `inference_batch_size` to `AppSettings`, restricted to `4 | 8 | 12 | 16`.
- Use 8 as the default when the Electron main process runs on `darwin/arm64`; use 4 elsewhere.
- When loading an older `settings.json` without this field, preserve its existing language and clip timing values and add the platform default. Invalid settings retain the existing full-default fallback behavior.
- Persist a user's explicit selection and use it for subsequent analysis tasks. Changing the setting does not alter an analysis already in progress.

## Settings UI

Add one four-option choice row to the existing Settings grid:

- 4: lowest memory use
- 8: balanced and recommended on Apple Silicon
- 12: higher throughput
- 16: highest memory use

The control reuses the existing choice-row visual language and saves immediately, like the pre-roll and post-roll controls. Chinese and English labels are added to the existing message table. The selected value remains visible after relaunch.

## Analysis request flow

1. The renderer includes the persisted Batch value when it calls `startAnalysis`.
2. Preload and main-process API types accept `batchSize`.
3. The main process validates the value and writes `batch_size` into the versioned worker request.
4. The Python worker accepts only 4, 8, 12, or 16 and constructs `TrackNetPredictor` with that value.

Keeping the value in the request makes every analysis task deterministic and avoids hidden environment-variable state.

## Out-of-memory backoff

The predictor starts with the selected Batch. If an inference call reports accelerator out-of-memory:

1. Clear the CUDA or MPS allocator cache when the installed Torch build exposes that operation.
2. Reduce the effective runtime Batch, splitting only the pending inputs into smaller ordered groups.
3. Retry those inputs, then keep the reduced Batch for the rest of the video so the same failure is not repeated.
4. Continue reducing down to 1 if necessary. If Batch 1 also fails, surface a device-neutral `DeviceError`.

Postprocessing state changes only after a successful model call, so retrying an OOM batch cannot duplicate trajectory points or corrupt tracking history. A fallback message is written to stderr for diagnostics; the normal progress protocol remains unchanged.

## Compatibility and behavior

- The same Batch setting is accepted for MPS, CUDA, and CPU, while only Apple Silicon receives the new default of 8.
- Output trajectory ordering and result counts must match the current implementation.
- This change does not introduce mixed precision, frame skipping, model conversion, or concurrent decode/inference. Those remain separate optimizations.
- Existing analysis and export result schemas stay unchanged.

## Verification

- TypeScript contract tests cover accepted and rejected Batch values.
- Settings tests cover Apple Silicon and non-Apple defaults plus migration from the old settings shape.
- Worker request tests cover the new required field and invalid values.
- Predictor unit tests simulate OOM, verify ordered retry at smaller sizes, verify that the reduced size remains active, and verify failure at Batch 1.
- Renderer/Electron workflow coverage verifies that choosing a Batch persists it and includes it in the next analysis request.
- Run TypeScript checks, Node tests, Python tests, and focused Electron end-to-end tests.
- Benchmark the same local video at Batch 4 and Batch 8 after implementation, reporting analysis FPS and confirming identical frame/result counts. Batch 12 and 16 are user-selectable but are not assumed to be faster on every machine.
