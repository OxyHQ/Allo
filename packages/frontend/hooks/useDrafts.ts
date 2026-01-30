import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DRAFTS_STORAGE_KEY = '@allo/drafts';

export interface Draft {
  id: string;
  postContent: string;
  mediaIds: string[];
  pollOptions: any[];
  article?: {
    title?: string;
    body?: string;
  };
  threadItems: any[];
  createdAt: number;
  updatedAt: number;
}

interface UseDraftsReturn {
  drafts: Draft[];
  isLoading: boolean;
  saveDraft: (draft: Omit<Draft, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateDraft: (id: string, draft: Partial<Draft>) => Promise<void>;
  deleteDraft: (id: string) => Promise<void>;
  getDraftById: (id: string) => Draft | null;
  loadDrafts: () => Promise<void>;
  clearAllDrafts: () => Promise<void>;
}

/**
 * Hook for managing message/post drafts
 * Allows users to save unfinished messages and load them later
 */
export function useDrafts(): UseDraftsReturn {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Load all drafts from storage
   */
  const loadDrafts = useCallback(async () => {
    try {
      setIsLoading(true);
      const stored = await AsyncStorage.getItem(DRAFTS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Draft[];
        // Sort by most recently updated first
        const sorted = parsed.sort((a, b) => b.updatedAt - a.updatedAt);
        setDrafts(sorted);
      } else {
        setDrafts([]);
      }
    } catch (error) {
      console.error('Error loading drafts:', error);
      setDrafts([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Save drafts to storage
   */
  const saveDraftsToStorage = useCallback(async (updatedDrafts: Draft[]) => {
    try {
      await AsyncStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(updatedDrafts));
    } catch (error) {
      console.error('Error saving drafts:', error);
      throw error;
    }
  }, []);

  /**
   * Save a new draft
   */
  const saveDraft = useCallback(async (draft: Omit<Draft, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    const now = Date.now();
    const id = `draft_${now}_${Math.random().toString(36).substr(2, 9)}`;

    const newDraft: Draft = {
      ...draft,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const updatedDrafts = [newDraft, ...drafts];
    setDrafts(updatedDrafts);
    await saveDraftsToStorage(updatedDrafts);

    return id;
  }, [drafts, saveDraftsToStorage]);

  /**
   * Update an existing draft
   */
  const updateDraft = useCallback(async (id: string, updates: Partial<Draft>) => {
    const updatedDrafts = drafts.map(draft => {
      if (draft.id === id) {
        return {
          ...draft,
          ...updates,
          updatedAt: Date.now(),
        };
      }
      return draft;
    });

    // Sort by most recently updated first
    const sorted = updatedDrafts.sort((a, b) => b.updatedAt - a.updatedAt);
    setDrafts(sorted);
    await saveDraftsToStorage(sorted);
  }, [drafts, saveDraftsToStorage]);

  /**
   * Delete a draft by ID
   */
  const deleteDraft = useCallback(async (id: string) => {
    const updatedDrafts = drafts.filter(draft => draft.id !== id);
    setDrafts(updatedDrafts);
    await saveDraftsToStorage(updatedDrafts);
  }, [drafts, saveDraftsToStorage]);

  /**
   * Get a draft by ID
   */
  const getDraftById = useCallback((id: string): Draft | null => {
    return drafts.find(draft => draft.id === id) || null;
  }, [drafts]);

  /**
   * Clear all drafts
   */
  const clearAllDrafts = useCallback(async () => {
    setDrafts([]);
    await AsyncStorage.removeItem(DRAFTS_STORAGE_KEY);
  }, []);

  // Load drafts on mount
  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  return {
    drafts,
    isLoading,
    saveDraft,
    updateDraft,
    deleteDraft,
    getDraftById,
    loadDrafts,
    clearAllDrafts,
  };
}
