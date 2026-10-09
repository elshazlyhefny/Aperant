/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the reference images box ("Drag & drop images or paste
 * screenshots") was a label with no handlers, so dropping or pasting there did
 * nothing. It now takes a drop, a paste once focused, and a click that opens
 * a file picker; the whole section accepts a drop.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../AgentProfileSelector', () => ({ AgentProfileSelector: () => null }));
vi.mock('../ClassificationFields', () => ({ ClassificationFields: () => null }));
vi.mock('../../ScreenshotCapture', () => ({ ScreenshotCapture: () => null }));
vi.mock('../ImagePreviewModal', () => ({ ImagePreviewModal: () => null }));
// Only the canvas-based thumbnail is replaced (jsdom has no canvas); the rest is real.
vi.mock('../../ImageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ImageUpload')>()),
  createThumbnail: async () => 'data:image/png;base64,thumb',
}));

import { TaskFormFields } from '../TaskFormFields';

const onImagesChange = vi.fn();

function form(disabled: boolean) {
  return (
    <TaskFormFields
      description=""
      onDescriptionChange={() => undefined}
      title=""
      onTitleChange={() => undefined}
      profileId=""
      model=""
      thinkingLevel=""
      onProfileChange={() => undefined}
      onModelChange={() => undefined}
      onThinkingLevelChange={() => undefined}
      onPhaseModelsChange={() => undefined}
      onPhaseThinkingChange={() => undefined}
      category=""
      priority=""
      complexity=""
      impact=""
      onCategoryChange={() => undefined}
      onPriorityChange={() => undefined}
      onComplexityChange={() => undefined}
      onImpactChange={() => undefined}
      showClassification={false}
      onShowClassificationChange={() => undefined}
      images={[]}
      onImagesChange={onImagesChange}
      requireReviewBeforeCoding={false}
      onRequireReviewChange={() => undefined}
      disabled={disabled}
    />
  );
}

function renderForm() {
  const view = render(form(false));
  fireEvent.click(screen.getByText('tasks:referenceImages.title'));
  return { zone: screen.getByTestId('reference-images-dropzone'), view };
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'mock.png', { type: 'image/png' });

function added(): Array<{ filename: string; mimeType: string }> {
  expect(onImagesChange).toHaveBeenCalled();
  return onImagesChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => onImagesChange.mockReset());

describe('reference images drop zone', () => {
  it('adds an image dropped on the box', async () => {
    const { zone } = renderForm();
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [png()], getData: () => '' } });
    });
    await waitFor(() => expect(added()).toHaveLength(1));
    expect(added()[0]).toMatchObject({ filename: 'mock.png', mimeType: 'image/png' });
  });

  it('adds a screenshot pasted into the box', async () => {
    const { zone } = renderForm();
    const item = { type: 'image/png', getAsFile: () => png() };
    await act(async () => {
      fireEvent.paste(zone, { clipboardData: { items: [item] } });
    });
    await waitFor(() => expect(added()).toHaveLength(1));
    expect(added()[0].filename).toMatch(/^screenshot-\d+\.png$/);
  });

  it('opens a file picker on click and adds the chosen images', async () => {
    const { zone } = renderForm();
    const input = screen.getByTestId('reference-images-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(zone);
    expect(click).toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(input, { target: { files: [png()] } });
    });
    await waitFor(() => expect(added()).toHaveLength(1));
  });

  it('does nothing while the form is disabled (e.g. during submission)', async () => {
    const { view } = renderForm();
    view.rerender(form(true));
    const zone = screen.getByTestId('reference-images-dropzone');
    const input = screen.getByTestId('reference-images-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [png()], getData: () => '' } });
      fireEvent.click(zone);
    });
    expect(onImagesChange).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
