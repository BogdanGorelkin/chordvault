import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsView } from '../SettingsView';

const mocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  exportSongsBlob: vi.fn(),
  fetchExportableSongs: vi.fn(),
  exportLibraryPdf: vi.fn(),
}));

vi.mock('../../hooks/useApi', () => ({ useApi: () => mocks.apiCall }));
vi.mock('../../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false }) }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { token: 'token', role: 'user' }, isAdmin: false }),
}));
vi.mock('../../lib/api', () => ({
  exportSongsBlob: mocks.exportSongsBlob,
  fetchExportableSongs: mocks.fetchExportableSongs,
}));
vi.mock('../../lib/pdf-export', () => ({ exportLibraryPdf: mocks.exportLibraryPdf }));
vi.mock('../../components/GeminiKeySettings', () => ({ GeminiKeySettings: () => null }));
vi.mock('../../components/ImportModal', () => ({ ImportModal: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiCall.mockRejectedValue(new Error('not configured'));
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

it('offers separate ChordPro and printable PDF exports', () => {
  render(<SettingsView />);
  expect(screen.getByRole('button', { name: 'Export ChordPro ZIP' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export Printable PDF' })).toBeInTheDocument();
  expect(screen.getByText(/editable plain text for backups/)).toBeInTheDocument();
});

it('downloads the ChordPro ZIP independently', async () => {
  mocks.exportSongsBlob.mockResolvedValue({ blob: new Blob(['zip']), filename: 'backup.zip' });
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Export ChordPro ZIP' }));
  await waitFor(() => expect(mocks.exportSongsBlob).toHaveBeenCalledWith('token'));
  expect(mocks.fetchExportableSongs).not.toHaveBeenCalled();
});

it('fetches songs and creates the printable PDF', async () => {
  const songs = [{ id: 1, title: 'Song', artist: '', content: '[G]lyrics', bpm: null }];
  mocks.fetchExportableSongs.mockResolvedValue(songs);
  mocks.exportLibraryPdf.mockResolvedValue([]);
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Export Printable PDF' }));
  await waitFor(() => expect(mocks.exportLibraryPdf).toHaveBeenCalledWith(songs));
  expect(await screen.findByText('Printable PDF exported')).toBeInTheDocument();
  expect(mocks.exportSongsBlob).not.toHaveBeenCalled();
});

it('reports characters that may be missing from the PDF', async () => {
  mocks.fetchExportableSongs.mockResolvedValue([{ id: 1, title: 'Song', artist: '', content: '[G]안녕', bpm: null }]);
  mocks.exportLibraryPdf.mockResolvedValue(['안']);
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Export Printable PDF' }));
  expect(await screen.findByText(/these characters may be missing: 안/)).toBeInTheDocument();
});
