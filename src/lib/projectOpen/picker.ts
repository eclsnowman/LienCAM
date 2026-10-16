import { create } from 'zustand'
export const useProjectPicker = create<{
  section: 'recent' | 'examples' | null
  show: (section?: 'recent' | 'examples') => void
  close: () => void
}>((set) => ({ section: null, show: (section = 'recent') => set({ section }), close: () => set({ section: null }) }))
