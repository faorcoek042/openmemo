import { render, blur, stubApi } from './host';
import { test } from 'node:test';
import { PurposeBindingsSection } from '../features/settings/PurposeBindingsSection';

test('dbg', async () => {
  const { calls } = stubApi({
    'GET /settings': { settings: { 'llm.providers': [], 'llm.defaultProviderId': 'openai', 'llm.defaultModelId': 'm' } },
    'PATCH /settings': { settings: {} },
  });
  const r = await render(<PurposeBindingsSection />);
  await r.flush();
  const input = r.container.querySelector('[data-testid="purpose-translate-model"]') as HTMLInputElement;
  console.log('INPUT FOUND:', !!input);
  input.value = 'x';
  await blur(input);
  await r.flush();
  console.log('CALLS:', JSON.stringify(calls));
});
