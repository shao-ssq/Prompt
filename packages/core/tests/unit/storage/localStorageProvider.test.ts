import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalStorageProvider } from '../../../src/services/storage/localStorageProvider';
import { StorageError } from '../../../src/services/storage/errors';

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    // Simple in-memory mock for localStorage
    mockStorage = {};
    global.localStorage = {
      getItem: vi.fn((key: string): string | null => mockStorage[key] || null),
      setItem: vi.fn((key: string, value: string): void => { mockStorage[key] = value.toString(); }),
      removeItem: vi.fn((key: string): void => { delete mockStorage[key]; }),
      clear: vi.fn((): void => { mockStorage = {}; }),
      key: vi.fn((index: number): string | null => Object.keys(mockStorage)[index] || null),
      get length(): number {
        return Object.keys(mockStorage).length;
      }
    } as any; // Use 'as any' to satisfy TypeScript if the mock is partial

    provider = new LocalStorageProvider();
  });

  afterEach(() => {
    // Clear any mocks
    vi.clearAllMocks();
  });

  describe('setItem and getItem', () => {
    it('should set and get an item', async () => {
      await provider.setItem('testKey', 'testValue');
      expect(global.localStorage.setItem).toHaveBeenCalledWith('testKey', 'testValue');
      
      const value = await provider.getItem('testKey');
      expect(global.localStorage.getItem).toHaveBeenCalledWith('testKey');
      expect(value).toBe('testValue');
    });

    it('should return null for a non-existent key', async () => {
      const value = await provider.getItem('nonExistentKey');
      expect(global.localStorage.getItem).toHaveBeenCalledWith('nonExistentKey');
      expect(value).toBeNull();
    });

    it('should overwrite an existing value', async () => {
      await provider.setItem('testKey', 'initialValue');
      await provider.setItem('testKey', 'newValue');
      expect(global.localStorage.setItem).toHaveBeenCalledWith('testKey', 'newValue');
      
      const value = await provider.getItem('testKey');
      expect(value).toBe('newValue');
    });
  });

  describe('removeItem', () => {
    it('should remove an item', async () => {
      await provider.setItem('keyToRemove', 'value');
      // Verify it's there before removing
      expect(await provider.getItem('keyToRemove')).toBe('value');

      await provider.removeItem('keyToRemove');
      expect(global.localStorage.removeItem).toHaveBeenCalledWith('keyToRemove');
      
      const value = await provider.getItem('keyToRemove');
      expect(value).toBeNull();
    });

    it('should not throw when removing a non-existent key', async () => {
      // Expecting the promise to resolve without error
      await expect(provider.removeItem('nonExistentKeyForRemove')).resolves.not.toThrow();
      expect(global.localStorage.removeItem).toHaveBeenCalledWith('nonExistentKeyForRemove');
    });

    it('should do nothing if removeItem is called on a non-existent key', async () => {
        await provider.setItem('existingKey', 'existingValue');
        await provider.removeItem('anotherNonExistentKey');
        expect(global.localStorage.removeItem).toHaveBeenCalledWith('anotherNonExistentKey');
        // Ensure other keys are not affected
        const value = await provider.getItem('existingKey');
        expect(value).toBe('existingValue');
      });
  });

  describe('clearAll', () => {
    it('should clear all items', async () => {
      await provider.setItem('key1', 'value1');
      await provider.setItem('key2', 'value2');

      await provider.clearAll();
      expect(global.localStorage.clear).toHaveBeenCalled();
      
      const value1 = await provider.getItem('key1');
      const value2 = await provider.getItem('key2');
      expect(value1).toBeNull();
      expect(value2).toBeNull();
    });

    it('should do nothing if clearAll is called when storage is already empty', async () => {
      await expect(provider.clearAll()).resolves.not.toThrow();
      expect(global.localStorage.clear).toHaveBeenCalled();
      // Double check by trying to get a non-existent key
      const value = await provider.getItem('anyKey');
      expect(value).toBeNull();
    });
  });

  // Test error handling for localStorage methods
  describe('Error Handling', () => {
    it('should reject with StorageError if localStorage.getItem throws', async () => {
      (global.localStorage.getItem as any).mockImplementationOnce(() => {
        throw new Error('Simulated getItem error');
      });
      await expect(provider.getItem('errorKey')).rejects.toThrow(StorageError);
    });

    it('should reject with StorageError if localStorage.setItem throws', async () => {
      (global.localStorage.setItem as any).mockImplementationOnce(() => {
        throw new Error('Simulated setItem error');
      });
      await expect(provider.setItem('errorKey', 'errorValue')).rejects.toThrow(StorageError);
    });

    it('should reject with StorageError if localStorage.removeItem throws', async () => {
      (global.localStorage.removeItem as any).mockImplementationOnce(() => {
        throw new Error('Simulated removeItem error');
      });
      await expect(provider.removeItem('errorKey')).rejects.toThrow(StorageError);
    });

    it('should reject with StorageError if localStorage.clear throws', async () => {
      (global.localStorage.clear as any).mockImplementationOnce(() => {
        throw new Error('Simulated clear error');
      });
      await expect(provider.clearAll()).rejects.toThrow(StorageError);
    });
  });
});
