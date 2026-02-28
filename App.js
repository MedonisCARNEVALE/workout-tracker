import React, { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar, TextInput, Alert, ScrollView, FlatList, ActivityIndicator, Dimensions, Platform, KeyboardAvoidingView, Keyboard, Animated, Easing, Modal, Pressable, Share, Vibration } from 'react-native';
import * as Speech from 'expo-speech';
import { Ionicons } from '@expo/vector-icons';
import { format, startOfMonth, startOfYear, addMonths, addYears } from 'date-fns';
import AsyncStorage from '@react-native-async-storage/async-storage';
import seedData from './seed_data.json'; 

const SCREEN_WIDTH = Dimensions.get('window').width;
const THEME = { bg: '#000', card: '#111', text: '#fff', accent: '#CCFF00', highlight: '#222', dim: '#444' };

const isWeb = typeof window !== 'undefined' && Platform.OS === 'web';
const speakTimer = (text) => {
  if (isWeb && typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  } else {
    Speech.speak(text, { language: 'en' });
  }
};
const stopTimerSpeech = () => {
  if (isWeb && typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  } else {
    Speech.stop();
  }
};

const parseNotesToSets = (notes) => {
  const part = String(notes || '').split('|')[0].trim();
  return part.split(',').map(s => s.trim()).filter(Boolean).map(segment => {
    const [w, r] = segment.split('x').map(x => x.trim());
    const weight = w === 'BW' || w === '' || !w ? 0 : parseFloat(w) || 0;
    const reps = parseInt(r, 10) || 0;
    return { weight, reps };
  });
};

// Normalize a set from seed or override to { weight, reps, modifier } (modifier: null | 'drop' | 'negative')
const normalizeSet = (s) => {
  if (!s || typeof s !== 'object') return { weight: '', reps: '', modifier: null };
  const repsRaw = s.reps != null ? String(s.reps).trim() : '';
  const isDropset = repsRaw.toLowerCase() === 'dropset' || repsRaw === 'Drop';
  const isNegative = repsRaw.toLowerCase() === 'negative' || repsRaw === 'Neg';
  let modifier = s.modifier ?? null;
  if (modifier !== 'drop' && modifier !== 'negative') modifier = isDropset ? 'drop' : isNegative ? 'negative' : null;
  const weight = s.weight != null ? String(s.weight) : '';
  const reps = modifier ? '' : (repsRaw === 'Dropset' || repsRaw === 'Negative' ? '' : repsRaw);
  return { weight, reps: reps === '' && !modifier ? '' : reps, modifier };
};

const normalizeExerciseSets = (ex) => {
  if (!ex) return ex;
  const sets = ex.sets;
  if (!Array.isArray(sets)) return { ...ex, sets: [{ weight: '', reps: '', modifier: null }] };
  const normalized = sets.map(normalizeSet);
  return { ...ex, sets: normalized };
};

const normalizeExerciseName = (name) => (name || '').trim().toLowerCase();

/** Build a notes string from seed_data.json record format (sets array) so history lookups work. */
const buildNotesFromSeedSets = (record) => {
  if (!record || !Array.isArray(record.sets) || record.sets.length === 0) return '';
  const parts = record.sets.map((s) => {
    const w = s.weight === 'Bodyweight' ? 'BW' : (s.weight != null ? String(s.weight) : '0');
    const r = s.reps != null ? String(s.reps) : '';
    return `${w}x${r}`;
  });
  const note = record.note ? String(record.note).trim() : '';
  return note ? `${parts.join(', ')} | ${note}` : parts.join(', ');
};

/** Normalize a log so it has .notes for getLastLogForExercise / parseNotesToSets. Seed_data has .sets; saved logs have .notes. */
const normalizeHistoryLog = (log) => {
  if (log.notes != null && String(log.notes).trim() !== '') return log;
  const notes = buildNotesFromSeedSets(log);
  return notes ? { ...log, notes } : log;
};

const getLastLogForExercise = (history, exerciseName) => {
  const notesStr = (log) => String(log.notes || log.note || '');
  const key = normalizeExerciseName(exerciseName);
  if (!key) return null;
  const matches = (history || []).filter(
    (log) =>
      normalizeExerciseName(log.exercise) === key &&
      notesStr(log).includes('x')
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const tA = a.completedAt ? new Date(a.completedAt).getTime() : parseWorkoutDate(a.date);
    const tB = b.completedAt ? new Date(b.completedAt).getTime() : parseWorkoutDate(b.date);
    return tB - tA;
  });
  return matches[0];
};

const allSetsMetTarget = (sets, targetReps) => {
  if (!sets.length) return false;
  const targetStr = String(targetReps || '').trim().toLowerCase();
  if (targetStr === 'fail' || targetStr === '') return sets.some(s => s.reps > 0);
  const targetNum = parseInt(targetReps, 10);
  if (isNaN(targetNum)) return sets.some(s => s.reps > 0);
  return sets.every(s => s.reps >= targetNum);
};

const getMaxWeightByExercise = (history) => {
  const map = {};
  (history || []).forEach((log) => {
    const name = normalizeExerciseName(log.exercise);
    if (!name || !log.notes) return;
    const sets = parseNotesToSets(log.notes);
    if (!sets.length) return;
    const maxInLog = Math.max(...sets.map((s) => s.weight), 0);
    if (maxInLog <= 0) return;
    if (map[name] == null || maxInLog > map[name]) map[name] = maxInLog;
  });
  return map;
};

const computeTonnageFromLogs = (logs) => {
  let total = 0;
  (logs || []).forEach((log) => {
    const sets = parseNotesToSets(log.notes);
    sets.forEach((s) => {
      const w = s.weight === 'BW' || s.weight === 0 ? 0 : Number(s.weight) || 0;
      const r = Number(s.reps) || 0;
      total += w * r;
    });
  });
  return Math.round(total);
};

const getTonnageComparison = (tonnage) => {
  if (tonnage < 1000) return "That's the weight of a grand piano. 🎹";
  if (tonnage < 2000) return "That is the weight of a Smart Car. 🚗";
  if (tonnage < 5000) return "You just lifted an adult Rhinoceros. 🦏";
  if (tonnage < 10000) return "You moved an entire African Elephant today. 🐘";
  if (tonnage < 20000) return "That is the equivalent of an F-16 Fighter Jet. ✈️";
  if (tonnage < 35000) return "You just casually lifted a School Bus. 🚌";
  return "🦍 APE MODE: You moved a fully loaded semi truck. Absolute unit.";
};

const getOverloadNudgeMap = (history, exercises) => {
  const map = {};
  (exercises || []).forEach((item) => {
    const name = item.exercise || '';
    if (!name) return;
    const lastLog = getLastLogForExercise(history, name);
    if (!lastLog || !lastLog.notes) return;
    const sets = parseNotesToSets(lastLog.notes);
    if (!sets.length) return;
    const met = allSetsMetTarget(sets, item.targetReps);
    if (!met) return;
    const maxWeight = Math.max(...sets.map(s => s.weight), 0);
    if (maxWeight <= 0) return;
    map[name] = { targetWeight: maxWeight + 5 };
  });
  return map;
};

// Order: Push A → Pull A → Legs A → Push B → Pull B → Legs B → Push C → Pull C → Legs KOT
const WORKOUT_SEQUENCE = [
  { type: 'Push', variation: 'A' }, { type: 'Pull', variation: 'A' }, { type: 'Legs', variation: 'A' },
  { type: 'Push', variation: 'B' }, { type: 'Pull', variation: 'B' }, { type: 'Legs', variation: 'B' },
  { type: 'Push', variation: 'C' }, { type: 'Pull', variation: 'C' }, { type: 'Legs', variation: 'KOT' },
];
const LAST_WORKOUT_KEY = 'workout_tracker_last_completed';
const OVERRIDES_KEY = 'workout_tracker_overrides';
const AB_TEMPLATES_KEY = 'workout_tracker_ab_templates';
const LAST_AB_WORKOUT_KEY = 'workout_tracker_last_ab_workout';
const ABS_SHOW_MIGRATION_KEY = 'workout_tracker_abs_show_migration_v2';
const IN_PROGRESS_WORKOUT_KEY = 'workout_tracker_in_progress';

const DEFAULT_AB_TEMPLATES = {
  A: { exercise: 'Decline weighted abs', note: '', targetReps: 'fail', sets: [{ weight: '35', reps: 'fail' }, { weight: '35', reps: 'fail' }, { weight: '35', reps: 'fail' }] },
  B: { exercise: 'Ab crunch machine', note: '', targetReps: 'fail', sets: [{ weight: '180', reps: 'fail' }, { weight: '180', reps: 'fail' }, { weight: '180', reps: 'fail' }] },
  C: { exercise: 'Abs oblique machine', note: '', targetReps: 'fail', sets: [{ weight: '110', reps: 'fail' }, { weight: '110', reps: 'fail' }, { weight: '110', reps: 'fail' }] },
};

// --- AB CYCLE UTILITIES ---
const getDaysSince = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return Infinity;
  const t = parseWorkoutDate(dateStr);
  if (!t) return Infinity;
  const now = new Date();
  const then = new Date(t);
  const diff = now.getTime() - then.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
};

const getNextAbType = (lastType) => {
  if (lastType === 'A') return 'B';
  if (lastType === 'B') return 'C';
  if (lastType === 'C') return 'A';
  return 'A';
};

const shouldInjectAbWorkout = (lastAbDate) => {
  if (lastAbDate == null || lastAbDate === '') return true;
  return getDaysSince(lastAbDate) >= 4;
};

const formatWorkoutForShare = (type, variation, exercises, inputs, injectedWarmups, substitutions, subSetCount) => {
  const header = `🦍 Today's Ape Workout: ${type} (${variation})`;
  const lines = (exercises || []).map((ex) => {
    const name = (substitutions && substitutions[ex.exercise]) || ex.exercise || 'Exercise';
    const warmups = injectedWarmups?.[ex.exercise] || [];
    const warmUpCount = warmups.length;
    const workingSetCount = substitutions?.[ex.exercise] ? (subSetCount?.[ex.exercise] ?? 1) : (ex.sets || []).length;
    const setIndices = Array.from({ length: warmUpCount + workingSetCount }, (_, i) => i);

    const warmUpParts = [];
    const workingParts = [];
    setIndices.forEach((setIdx) => {
      const isWarmup = setIdx < warmUpCount;
      const fromInputs = inputs?.[ex.exercise]?.sets?.[setIdx];
      let weight = fromInputs?.weight;
      let reps = fromInputs?.reps;
      const modifier = fromInputs?.modifier;
      if (isWarmup) {
        if (weight == null && reps == null && warmups[setIdx]) {
          weight = warmups[setIdx].weight;
          reps = warmups[setIdx].reps;
        }
        const w = weight === 'BW' || weight === '' || weight == null ? 'BW' : String(weight);
        const r = reps != null && String(reps).trim() !== '' ? String(reps) : '';
        if (w || r) warmUpParts.push(r ? `${w}×${r}` : w);
      } else {
        if (modifier === 'drop') workingParts.push('Dropset');
        else if (modifier === 'negative') workingParts.push('Negative');
        else {
          const w = weight === 'BW' || weight === '' || weight == null ? '0' : String(weight);
          const r = reps != null && String(reps).trim() !== '' ? String(reps) : '0';
          workingParts.push(`${w}×${r}`);
        }
      }
    });

    const parts = [];
    if (warmUpParts.length > 0) parts.push(`Warm-up: ${warmUpParts.join(', ')}`);
    if (workingParts.length > 0) parts.push(`Working: ${workingParts.join(', ')}`);
    if (parts.length === 0) {
      const setCount = workingSetCount;
      const reps = ex.targetReps ?? ex.sets?.[0]?.reps ?? '';
      const repsLabel = reps ? (String(reps).toLowerCase() === 'fail' ? `${setCount} sets × fail` : `${setCount} sets × ${reps} reps`) : `${setCount} sets`;
      return `🔸 ${name}\n${repsLabel}`;
    }
    return `🔸 ${name}\n${parts.join('\n')}`;
  });
  return [header, '', ...lines].join('\n');
};

// --- UTILITIES ---
const getWeight = (str) => {
  if (!str || typeof str !== 'string') return 0;
  const match = str.match(/(\d+)/);
  return match ? parseInt(match[0]) : 0;
};

const parseWorkoutDate = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  const parts = dateStr.split('/').map(Number);
  if (parts.length < 3) return 0;
  const year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
  return new Date(year, parts[0] - 1, parts[1]).getTime();
};

// Return true if search query matches this log (exercise or flexible date match).
function searchMatchesLog(search, log) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return true;
  if (log.exercise && log.exercise.toLowerCase().includes(q)) return true;
  if (log.date && log.date.toLowerCase().includes(q)) return true;
  const t = parseWorkoutDate(log.date);
  if (!t) return false;
  const d = new Date(t);
  const logMonth = d.getMonth() + 1, logDay = d.getDate(), logYear = d.getFullYear();
  // "1/12" or "1-12" → same month and day (any year)
  const bySlash = q.split('/').map(s => s.trim());
  const byDash = q.split('-').map(s => s.trim());
  if (bySlash.length === 2 && !isNaN(Number(bySlash[0])) && !isNaN(Number(bySlash[1]))) {
    if (parseInt(bySlash[0], 10) === logMonth && parseInt(bySlash[1], 10) === logDay) return true;
  }
  if (byDash.length === 2 && !isNaN(Number(byDash[0])) && !isNaN(Number(byDash[1]))) {
    if (parseInt(byDash[0], 10) === logMonth && parseInt(byDash[1], 10) === logDay) return true;
  }
  // "January 2025", "jan 2025", "Jan 2025" → month + year
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const abbrev = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let i = 0; i < 12; i++) {
    if (!q.includes(months[i]) && !q.includes(abbrev[i])) continue;
    const yearMatch = q.match(/\b(20\d{2}|\d{2})\b/);
    const year = yearMatch ? (yearMatch[1].length === 2 ? 2000 + parseInt(yearMatch[1], 10) : parseInt(yearMatch[1], 10)) : null;
    if (year != null && logYear === year && logMonth === i + 1) return true;
    if (year == null && logMonth === i + 1) return true;
  }
  return false;
}

/**
 * From workout history, get up to `count` session dates that each have a *different*
 * set of exercises (so A/B/C or A/B are distinct templates). Dates sorted newest first.
 * Cached by (typeKey, count) to avoid recomputing when seed_data is large.
 */
const _distinctDatesCache = new Map();
const CACHE_MAX = 20;
const getDistinctSessionDates = (data, typeKey, count) => {
  const key = `${(typeKey || '').toLowerCase()}|${count}`;
  const cached = _distinctDatesCache.get(key);
  if (cached) return cached;
  const filtered = data.filter(
    (d) => d.type && d.type.toLowerCase().includes((typeKey || '').toLowerCase())
  );
  const byDate = {};
  filtered.forEach((d) => {
    if (!byDate[d.date]) byDate[d.date] = [];
    byDate[d.date].push(d);
  });
  const dates = Object.keys(byDate).sort(
    (a, b) => parseWorkoutDate(b) - parseWorkoutDate(a)
  );
  const seenSignatures = new Set();
  const result = [];
  for (const date of dates) {
    const entries = byDate[date];
    const signature = entries
      .map((e) => (e.exercise || '').trim().toLowerCase())
      .sort()
      .join('|');
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    result.push(date);
    if (result.length >= count) break;
  }
  if (_distinctDatesCache.size >= CACHE_MAX) {
    const first = _distinctDatesCache.keys().next().value;
    _distinctDatesCache.delete(first);
  }
  _distinctDatesCache.set(key, result);
  return result;
};

// --- TODAY SCREEN COMPONENT ---
const TodayScreenInner = ({ history, onFinish, initialType, initialVariation, overrides, onSaveOverrides, abTemplates, lastAbWorkout, showSuccessScreen, onDismissSuccess, onStartTwoADay, onUndoLastSession, canUndo, totalTonnage, onProgressUpdate, startRestTimer, cancelRestTimer, initialInProgress }) => {
  const [todaysType, setTodaysType] = useState(initialType || 'Push');
  const [variation, setVariation] = useState(initialVariation || 'A');
  const [inputs, setInputs] = useState({});
  const [substitutions, setSubstitutions] = useState({}); // { originalName: 'Replacement name' } - session only
  const [subSetCount, setSubSetCount] = useState({}); // { originalName: number } - sets count when subbed (today only)
  const [subbingFor, setSubbingFor] = useState(null);
  const [subModifier, setSubModifier] = useState(null);
  const [subInputValue, setSubInputValue] = useState('');
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingExercises, setEditingExercises] = useState([]);
  const [newExerciseName, setNewExerciseName] = useState('');
  const [shoulderWarmupDone, setShoulderWarmupDone] = useState(false);
  const [injectedWarmups, setInjectedWarmups] = useState({}); // { exerciseName: [ { weight, reps }, ... ] }
  const inputsRef = useRef(inputs);
  const hasRestoredRef = useRef(false);
  useEffect(() => { inputsRef.current = inputs; }, [inputs]);

  useEffect(() => {
    if (initialType) setTodaysType(initialType);
    if (initialVariation) setVariation(initialVariation);
  }, [initialType, initialVariation]);

  useEffect(() => {
    if (hasRestoredRef.current || !initialInProgress) return;
    const today = format(new Date(), 'MM/dd/yy');
    if (initialInProgress.date !== today) return;
    hasRestoredRef.current = true;
    setTodaysType(initialInProgress.type || initialType || 'Push');
    setVariation(initialInProgress.variation || initialVariation || 'A');
    setInputs(initialInProgress.inputs || {});
    setSubstitutions(initialInProgress.substitutions || {});
    setSubSetCount(initialInProgress.subSetCount || {});
    setInjectedWarmups(initialInProgress.injectedWarmups || {});
  }, [initialInProgress, initialType, initialVariation]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const payload = {
        date: format(new Date(), 'MM/dd/yy'),
        type: todaysType,
        variation,
        inputs,
        substitutions,
        subSetCount,
        injectedWarmups,
      };
      AsyncStorage.setItem(IN_PROGRESS_WORKOUT_KEY, JSON.stringify(payload));
    }, 1500);
    return () => clearTimeout(timer);
  }, [todaysType, variation, inputs, substitutions, subSetCount, injectedWarmups]);

  const showBWButton = (name) => {
    const bwKeywords = ['squat', 'push up', 'pull up', 'chin up', 'dip', 'abs', 'leg raise', 'crunch', 'sit up', 'hanging', 'plank'];
    return bwKeywords.some(k => name.toLowerCase().includes(k));
  };

  const currentWorkout = useMemo(() => {
    const overrideData = overrides?.[todaysType]?.[variation];
    const overrideExercises = overrideData?.exercises;
    if (overrideExercises?.length) {
      const exercises = overrideExercises.map(normalizeExerciseSets);
      return {
        type: todaysType === 'Legs' ? 'Heavy Legs and Shoulders' : todaysType,
        date: overrideData?.lastCompletedDate ?? 'Custom',
        exercises,
      };
    }
    // Special handling for Legs day
    if (todaysType === 'Legs') {
      const heavyKey = 'heavy legs and shoulders';
      const kotKey = 'kot';

      const heavySessions = seedData.filter(
        d => d.type && d.type.toLowerCase().includes(heavyKey)
      );
      const kotSessions = seedData.filter(
        d => d.type && d.type.toLowerCase().includes(kotKey)
      );

      if (variation === 'KOT') {
        const uniqueDates = [...new Set(kotSessions.map(d => d.date))].sort(
          (a, b) => parseWorkoutDate(b) - parseWorkoutDate(a)
        );
        const targetDate = uniqueDates[0];
        const exercisesForDate = kotSessions.filter(d => d.date === targetDate);

        const isMartyName = (name) =>
          typeof name === 'string' &&
          name.replace('.', '').trim().toLowerCase() === 'marty st louis';

        // Pull out original Marty (with or without period) to reuse its note
        const originalMarty = exercisesForDate.find(ex => isMartyName(ex.exercise));
        const otherExercises = exercisesForDate.filter(ex => !isMartyName(ex.exercise));

        // Custom Marty St Louis with 3 empty sets (reps only), preserving note
        const martyExercise = {
          exercise: 'Marty St Louis',
          note: originalMarty?.note || '',
          sets: [
            { weight: '', reps: '', modifier: null },
            { weight: '', reps: '', modifier: null },
            { weight: '', reps: '', modifier: null },
          ],
        };

        return {
          type: 'KOT',
          date: targetDate,
          // Marty first, then the rest (no duplicate)
          exercises: [martyExercise, ...otherExercises.map(normalizeExerciseSets)],
        };
      }

      // Legs A/B → two most recent *distinct* Heavy Legs and Shoulders templates
      const distinctDates = getDistinctSessionDates(
        seedData,
        'heavy legs and shoulders',
        2
      );
      const targetIdx = variation === 'A' ? 0 : 1;
      const targetDate = distinctDates[targetIdx] || distinctDates[0];
      return {
        type: 'Heavy Legs and Shoulders',
        date: targetDate,
        exercises: heavySessions.filter((d) => d.date === targetDate).map(normalizeExerciseSets),
      };
    }

    // Push / Pull: three most recent *distinct* templates (different exercises)
    const searchKey = todaysType;
    const distinctDates = getDistinctSessionDates(seedData, searchKey, 3);
    let targetDate;
    if (todaysType === 'Push' && variation === 'B') {
      targetDate = '11/10/2025'; // Push B = Nov 10 2025 workout
    } else {
      const targetIdx = variation === 'A' ? 0 : variation === 'B' ? 1 : 2;
      targetDate = distinctDates[targetIdx] ?? distinctDates[0];
    }
    const filtered = seedData.filter(
      (d) =>
        d.type &&
        d.type.toLowerCase().includes(searchKey.toLowerCase()) &&
        d.date === targetDate
    );
    return {
      type: filtered[0]?.type || searchKey,
      date: targetDate,
      exercises: filtered.map(normalizeExerciseSets),
    };
  }, [todaysType, variation, overrides]);

  const injectedAb = useMemo(() => {
    const lastAbDate = lastAbWorkout?.date;
    if (!shouldInjectAbWorkout(lastAbDate)) return null;
    const nextType = getNextAbType(lastAbWorkout?.type ?? null);
    const template = abTemplates?.[nextType];
    if (!template) return null;
    let sets = (template.sets || []).map(s => ({ weight: String(s.weight ?? ''), reps: String(s.reps ?? '').trim() || '' }));
    if (sets.length === 0) sets = [{ weight: '', reps: '' }, { weight: '', reps: '' }, { weight: '', reps: '' }];
    return {
      type: nextType,
      exercise: {
        exercise: template.exercise,
        note: template.note ?? '',
        targetReps: template.targetReps ?? 'fail',
        sets,
        _abCycle: nextType,
      },
    };
  }, [abTemplates, lastAbWorkout?.date, lastAbWorkout?.type]);

  const exercisesToShow = useMemo(() => {
    const base = currentWorkout.exercises || [];
    if (injectedAb) return [...base, injectedAb.exercise];
    return base;
  }, [currentWorkout.exercises, injectedAb]);

  const exerciseBlocks = useMemo(() => {
    const list = exercisesToShow;
    const blocks = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].isSupersetWithNext && i + 1 < list.length) {
        blocks.push({ type: 'superset', indices: [i, i + 1] });
        i++;
      } else {
        blocks.push({ type: 'single', indices: [i] });
      }
    }
    return blocks;
  }, [exercisesToShow]);

  const overloadNudgeMap = useMemo(
    () => getOverloadNudgeMap(history, exercisesToShow),
    [history, exercisesToShow]
  );

  const maxWeightByExercise = useMemo(() => getMaxWeightByExercise(history), [history]);

  const lastLogByExercise = useMemo(() => {
    const m = {};
    (exercisesToShow || []).forEach((item) => {
      const name = item.exercise || '';
      if (!name) return;
      const lookupName = substitutions[item.exercise] || item.exercise;
      const log = getLastLogForExercise(history, lookupName);
      if (!log) return;
      m[name] = { log, sets: parseNotesToSets(log.notes || '') };
    });
    return m;
  }, [history, exercisesToShow, substitutions]);

  const globalActivePosition = useMemo(() => {
    for (let exIdx = 0; exIdx < exercisesToShow.length; exIdx++) {
      const item = exercisesToShow[exIdx];
      const isSubbed = !!substitutions[item.exercise];
      const warmUpCount = (injectedWarmups[item.exercise] || []).length;
      const workingSetCount = isSubbed ? (subSetCount[item.exercise] ?? 1) : (item.sets || []).length;
      const effectiveSetIndices = Array.from({ length: warmUpCount + workingSetCount }, (_, i) => i);
      for (const setIdx of effectiveSetIndices) {
        const setMod = inputs[item.exercise]?.sets?.[setIdx]?.modifier ?? (item.sets || [])[setIdx - warmUpCount]?.modifier ?? null;
        const isSpecial = setMod === 'drop' || setMod === 'negative';
        const w = inputs[item.exercise]?.sets?.[setIdx]?.weight;
        const r = inputs[item.exercise]?.sets?.[setIdx]?.reps;
        const hasWeight = w != null && String(w).trim() !== '';
        const hasReps = r != null && String(r).trim() !== '';
        if (isSpecial) {
          if (r !== '✓') return { exIdx, setIdx };
        } else {
          if (!hasWeight || !hasReps) return { exIdx, setIdx };
        }
      }
    }
    return null;
  }, [exercisesToShow, inputs, substitutions, subSetCount, injectedWarmups]);

  const workoutProgress = useMemo(() => {
    let total = 0;
    let completed = 0;
    exercisesToShow.forEach((item) => {
      const isSubbed = !!substitutions[item.exercise];
      const warmUpCount = (injectedWarmups[item.exercise] || []).length;
      const workingSetCount = isSubbed ? (subSetCount[item.exercise] ?? 1) : (item.sets || []).length;
      const effectiveSetIndices = Array.from({ length: warmUpCount + workingSetCount }, (_, i) => i);
      effectiveSetIndices.forEach((setIdx) => {
        total += 1;
        const setMod = inputs[item.exercise]?.sets?.[setIdx]?.modifier ?? (item.sets || [])[setIdx - warmUpCount]?.modifier ?? null;
        const isSpecial = setMod === 'drop' || setMod === 'negative';
        const w = inputs[item.exercise]?.sets?.[setIdx]?.weight;
        const r = inputs[item.exercise]?.sets?.[setIdx]?.reps;
        const hasWeight = w != null && String(w).trim() !== '';
        const hasReps = r != null && String(r).trim() !== '';
        if (isSpecial) {
          if (r === '✓') completed += 1;
        } else {
          if (hasWeight && hasReps) completed += 1;
        }
      });
    });
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, pct, isComplete: total > 0 && completed >= total };
  }, [exercisesToShow, inputs, substitutions, subSetCount, injectedWarmups]);

  useEffect(() => {
    onProgressUpdate?.(workoutProgress);
  }, [workoutProgress, onProgressUpdate]);

  const [prSetKeys, setPrSetKeys] = useState({}); // { 'exerciseName-setIdx': true }
  const prSetKeysRef = useRef({});
  useEffect(() => { prSetKeysRef.current = prSetKeys; }, [prSetKeys]);

  const [finishEarlyModalVisible, setFinishEarlyModalVisible] = useState(false);
  const [incompleteSetCount, setIncompleteSetCount] = useState(0);

  const countIncompleteSets = () => {
    let incomplete = 0;
    exercisesToShow.forEach((item) => {
      const warmUpCount = (injectedWarmups[item.exercise] || []).length;
      const workingSetCount = substitutions[item.exercise] ? (subSetCount[item.exercise] ?? 1) : (item.sets || []).length;
      const setIndices = Array.from({ length: warmUpCount + workingSetCount }, (_, i) => i);
      setIndices.forEach((setIdx) => {
        const setMod = inputs[item.exercise]?.sets?.[setIdx]?.modifier ?? (item.sets || [])[setIdx - warmUpCount]?.modifier ?? null;
        const isSpecial = setMod === 'drop' || setMod === 'negative';
        const s = inputs[item.exercise]?.sets?.[setIdx];
        const hasWeight = s?.weight != null && String(s.weight).trim() !== '';
        const hasReps = s?.reps != null && String(s.reps).trim() !== '';
        if (isSpecial) {
          if (s?.reps !== '✓') incomplete += 1;
        } else {
          if (!hasWeight || !hasReps) incomplete += 1;
        }
      });
    });
    return incomplete;
  };

  const showShoulderCard =
    todaysType === 'Push' ||
    (todaysType === 'Legs' && (variation === 'A' || variation === 'B'));

  const getWorkingWeightForExercise = (item) => {
    const name = item.exercise || '';
    const exInputs = inputs[name]?.sets || {};
    const fromInputs = Object.keys(exInputs)
      .map((idx) => {
        const w = exInputs[idx]?.weight;
        if (w === 'BW' || !w) return 0;
        return parseFloat(String(w).replace(/[^0-9.]/g, ''), 10) || 0;
      })
      .filter((n) => n > 0);
    if (fromInputs.length) return Math.max(...fromInputs);
    const firstSet = item.sets?.[0];
    if (firstSet) {
      const w = firstSet.weight;
      if (w === 'Bodyweight' || w === 'BW') return 0;
      const n = parseFloat(String(w).replace(/[^0-9.]/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    const nudge = overloadNudgeMap[name];
    if (nudge?.targetWeight) return nudge.targetWeight;
    return null;
  };

  const generateWarmupsForExercise = (item) => {
    const working = getWorkingWeightForExercise(item);
    if (working == null || working <= 0) {
      Alert.alert('Warm-ups', 'Enter a working weight for this exercise first (or use the Last/Target weight shown).');
      return;
    }
    const w1 = Math.round((working * 0.5) / 2.5) * 2.5 || 2.5;
    const w2 = Math.round((working * 0.7) / 2.5) * 2.5 || 2.5;
    const w3 = Math.round((working * 0.85) / 2.5) * 2.5 || 2.5;
    setInjectedWarmups((prev) => ({
      ...prev,
      [item.exercise]: [
        { weight: w1, reps: 8 },
        { weight: w2, reps: 4 },
        { weight: w3, reps: 2 },
      ],
    }));
    const exInputs = inputs[item.exercise]?.sets || {};
    const warmupDefaults = {
      0: { weight: String(w1), reps: '8' },
      1: { weight: String(w2), reps: '4' },
      2: { weight: String(w3), reps: '2' },
    };
    const shifted = {};
    Object.keys(exInputs).forEach((idx) => {
      shifted[String(Number(idx) + 3)] = exInputs[idx];
    });
    setInputs((prev) => ({
      ...prev,
      [item.exercise]: {
        ...prev[item.exercise],
        sets: { ...warmupDefaults, ...shifted },
      },
    }));
  };

  const updateSetInput = (exerciseName, setIndex, field, value) => {
    setInputs(prev => ({
      ...prev,
      [exerciseName]: {
        ...prev[exerciseName],
        sets: { ...prev[exerciseName]?.sets, [setIndex]: { ...prev[exerciseName]?.sets?.[setIndex], [field]: value } }
      }
    }));
  };

  const getSetModifier = (item, setIdx, warmUpCount, isSubbed) => {
    if (setIdx < warmUpCount) return null;
    const inputMod = inputs[item.exercise]?.sets?.[setIdx]?.modifier;
    if (inputMod === 'drop' || inputMod === 'negative') return inputMod;
    const templateSet = (item.sets || [])[setIdx - warmUpCount];
    return templateSet?.modifier ?? null;
  };

  const getExerciseSetSummary = (item, isSubbed) => {
    const workingSets = isSubbed ? (subSetCount[item.exercise] ?? 1) : (item.sets || []).length;
    if (workingSets === 0) return '';

    let normalCount = 0;
    let dropCount = 0;
    let negCount = 0;
    if (isSubbed) {
      const sets = inputs[item.exercise]?.sets || {};
      for (let i = 0; i < workingSets; i++) {
        const mod = sets[i]?.modifier ?? null;
        if (mod === 'drop') dropCount++;
        else if (mod === 'negative') negCount++;
        else normalCount++;
      }
    } else {
      (item.sets || []).forEach((s) => {
        const mod = s?.modifier ?? null;
        if (mod === 'drop') dropCount++;
        else if (mod === 'negative') negCount++;
        else normalCount++;
      });
    }

    const parts = [];
    if (normalCount > 0) parts.push(`${normalCount} set${normalCount !== 1 ? 's' : ''}`);
    if (dropCount > 0) parts.push(`${dropCount} drop${dropCount !== 1 ? 's' : ''}`);
    if (negCount > 0) parts.push(`${negCount} neg${negCount !== 1 ? 's' : ''}`);
    if (parts.length === 0) return '';
    return ` - ${parts.join(' + ')}`;
  };

  const isSetComplete = (name, setIdx, setMod, s) => {
    if (!s) return false;
    if (setMod === 'drop' || setMod === 'negative') return s.reps === '✓';
    const hasWeight = s.weight != null && String(s.weight).trim() !== '';
    const hasReps = s.reps != null && String(s.reps).trim() !== '';
    return hasWeight && hasReps;
  };

  const save = (abs, pruneEmpty = false) => {
    const completedAt = new Date().toISOString();
    const logs = Object.keys(inputs).map(name => {
      const ex = inputs[name] || {};
      const item = exercisesToShow.find(e => e.exercise === name);
      const warmUpCount = item ? (injectedWarmups[name] || []).length : 0;
      const setIndices = Object.keys(ex.sets || {}).map(Number).sort((a, b) => a - b);
      const setArray = [];
      setIndices.forEach(idx => {
        const s = ex.sets[idx];
        const setMod = s?.modifier ?? (item?.sets || [])[idx - warmUpCount]?.modifier ?? null;
        if (pruneEmpty && !isSetComplete(name, idx, setMod, s)) return;
        if (setMod === 'drop') setArray.push('Dropset');
        else if (setMod === 'negative') setArray.push('Negative');
        else setArray.push(`${s?.weight ?? 0}x${s?.reps ?? 0}`);
      });
      const loggedName = substitutions[name] ?? name;
      if (pruneEmpty && setArray.length === 0) return null;
      return {
        date: format(new Date(), 'MM/dd/yy'),
        completedAt,
        exercise: loggedName,
        notes: setArray.join(', ') + (ex.cues ? ` | ${ex.cues}` : '') + (abs ? ' (Abs Done)' : ''),
        weight: ex.sets?.['0']?.weight === 'BW' ? 0 : getWeight(setArray[0] || ''),
        type: currentWorkout.type,
      };
    }).filter(Boolean);
    let abCompletion = null;
    const abItem = exercisesToShow.find(it => it._abCycle);
    if (abItem) {
      const ex = inputs[abItem.exercise] || {};
      const setKeys = Object.keys(ex.sets || {}).map(Number).sort((a, b) => a - b);
      const sets = setKeys.length
        ? setKeys.map(idx => {
            const s = ex.sets[idx];
            const setMod = s?.modifier ?? (abItem.sets || [])[idx - (injectedWarmups[abItem.exercise] || []).length]?.modifier ?? null;
            if (pruneEmpty && !isSetComplete(abItem.exercise, idx, setMod, s)) return null;
            return { weight: String(s?.weight ?? ''), reps: String(s?.reps ?? '').trim() || '' };
          }).filter(Boolean)
        : (abItem.sets || []).map(s => ({ weight: String(s?.weight ?? ''), reps: String(s?.reps ?? '').trim() || '' }));
      if (!pruneEmpty || sets.length > 0) {
        abCompletion = {
          type: abItem._abCycle,
          template: {
            exercise: abItem.exercise,
            note: ex.cues ?? abItem.note ?? '',
            targetReps: abItem.targetReps ?? 'fail',
            sets,
          },
        };
        const abLogged = logs.some(l => l.exercise === abItem.exercise || (substitutions[abItem.exercise] && l.exercise === substitutions[abItem.exercise]));
        if (!abLogged) {
          const setArray = sets.map(s => `${s.weight || 0}x${s.reps || 0}`);
          logs.push({
            date: format(new Date(), 'MM/dd/yy'),
            completedAt,
            exercise: substitutions[abItem.exercise] ?? abItem.exercise,
            notes: setArray.join(', ') + (ex.cues ? ` | ${ex.cues}` : ''),
            weight: ex.sets?.['0']?.weight === 'BW' ? 0 : getWeight(setArray[0] || ''),
            type: currentWorkout.type,
          });
        }
      }
    }
    const abSkipped = !!injectedAb && !abCompletion;
    onFinish(logs, { type: todaysType, variation }, abCompletion, { abSkipped });
    setInputs({});
    setSubstitutions({});
    setSubSetCount({});
  };

  if (showSuccessScreen) {
    const tonnageFormatted = totalTonnage != null ? totalTonnage.toLocaleString() : '0';
    const tonnageComparison = totalTonnage != null ? getTonnageComparison(totalTonnage) : '';
    return (
      <View style={[styles.container, styles.successContainer]}>
        <Text style={styles.successTitle}>🦍 Ape Mode Complete</Text>
        <Text style={styles.successMessage}>2026 Log Saved.</Text>
        {totalTonnage != null && (
          <View style={styles.successTonnageBlock}>
            <Text style={styles.successTonnageLabel}>Total Volume</Text>
            <Text style={styles.successTonnageValue}>{tonnageFormatted} lbs</Text>
            {tonnageComparison ? <Text style={styles.successTonnageComparison}>{tonnageComparison}</Text> : null}
          </View>
        )}
        <TouchableOpacity style={styles.successPrimaryBtn} onPress={onDismissSuccess}>
          <Text style={styles.successPrimaryBtnText}>Done</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.successSecondaryBtn} onPress={onStartTwoADay}>
          <Text style={styles.successSecondaryBtnText}>Start Another Session (Two-a-Day)</Text>
        </TouchableOpacity>
        {canUndo && onUndoLastSession ? (
          <TouchableOpacity style={styles.successUndoBtn} onPress={onUndoLastSession}>
            <Text style={styles.successUndoBtnText}>Undo — remove this workout from history</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1 }}>
      <ScrollView 
        contentContainerStyle={styles.scroll} 
        keyboardShouldPersistTaps="always"
        removeClippedSubviews={false} // Prevents iOS from "unmounting" middle inputs
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.title}>{format(new Date(), 'EEEE').toUpperCase()}</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={styles.cycleBtn}
            onPress={() => {
              setTodaysType(t => {
                const next = t === 'Push' ? 'Pull' : t === 'Pull' ? 'Legs' : 'Push';
                return next;
              });
              // Reset variation to A whenever type changes
              setVariation('A');
            }}
          >
            <Text style={styles.cycleLabel}>TYPE</Text>
            <Text style={styles.cycleValue}>
              {todaysType === 'Legs' ? 'LEGS/SHOULDERS' : todaysType.toUpperCase()}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cycleBtn}
            onPress={() =>
              setVariation(v => {
                if (todaysType === 'Legs') {
                  return v === 'A' ? 'B' : v === 'B' ? 'KOT' : 'A';
                }
                // Push / Pull – cycle A/B/C
                return v === 'A' ? 'B' : v === 'B' ? 'C' : 'A';
              })
            }
          >
            <Text style={styles.cycleLabel}>VARIATION</Text>
            <Text style={styles.cycleValue}>{variation}</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.sourceDate}>Source: {currentWorkout.date}</Text>

        <View style={styles.editShareRow}>
          <TouchableOpacity style={[styles.subBtn, { marginBottom: 12 }]} onPress={() => {
            setEditingExercises(currentWorkout.exercises.map(e => {
              const sets = e.sets?.map(s => ({ weight: s.weight ?? '', reps: String(s.reps ?? '').trim() || '', modifier: s.modifier ?? null })) ?? [{ weight: '', reps: '', modifier: null }];
              return { ...e, sets, targetReps: e.targetReps ?? '' };
            }));
            setNewExerciseName('');
            setEditModalVisible(true);
          }}>
            <Text style={styles.subBtnText}>Edit workout</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.subBtn, { marginBottom: 12 }]}
            onPress={() => {
              const message = formatWorkoutForShare(todaysType, variation, exercisesToShow, inputs, injectedWarmups, substitutions, subSetCount);
              Share.share({ message });
            }}
          >
            <Text style={styles.subBtnText}>Share</Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={editModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setEditModalVisible(false)}
        >
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderRow}>
                <Text style={styles.modalTitle}>Edit {todaysType} {variation} template</Text>
                <View style={styles.modalHeaderActions}>
                  <Pressable style={styles.modalCancelBtn} onPress={() => setEditModalVisible(false)}>
                    <Text style={styles.modalCancelBtnText}>Cancel</Text>
                  </Pressable>
                  <TouchableOpacity style={styles.modalSaveHeaderBtn} onPress={() => {
                    onSaveOverrides?.(todaysType, variation, editingExercises);
                    setEditModalVisible(false);
                  }}>
                    <Text style={styles.modalSaveHeaderBtnText}>Save template</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={styles.modalSubtitle}>Changes apply to future workouts</Text>
            </View>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalSectionLabel}>Exercises (drag to reorder)</Text>
              {editingExercises.map((ex, idx) => (
                <Fragment key={`ex-${idx}-${ex.exercise}`}>
                  <View style={styles.templateExerciseCard}>
                    <View style={styles.templateExerciseHeader}>
                      <View style={styles.templateGripRow}>
                        <Text style={styles.gripIcon}>⋮⋮</Text>
                        <TouchableOpacity style={styles.moveBtn} onPress={() => idx > 0 && setEditingExercises(prev => { const n = [...prev]; [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]]; return n; })} disabled={idx === 0}>
                          <Text style={[styles.moveBtnText, idx === 0 && styles.moveBtnTextDisabled]}>↑</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.moveBtn} onPress={() => idx < editingExercises.length - 1 && setEditingExercises(prev => { const n = [...prev]; [n[idx], n[idx + 1]] = [n[idx + 1], n[idx]]; return n; })} disabled={idx === editingExercises.length - 1}>
                          <Text style={[styles.moveBtnText, idx === editingExercises.length - 1 && styles.moveBtnTextDisabled]}>↓</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.templateExerciseName} numberOfLines={2}>{ex.exercise}</Text>
                      <TouchableOpacity style={styles.modalRemoveBtn} onPress={() => setEditingExercises(prev => prev.filter((_, i) => i !== idx))}>
                        <Text style={styles.modalRemoveText}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.templateMetaRow}>
                      <View style={styles.setsStepperRow}>
                        <Text style={styles.setsStepperLabel}>Sets</Text>
                        <TouchableOpacity style={styles.stepperBtn} onPress={() => { if (ex.sets.length <= 1) return; setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, sets: e.sets.slice(0, -1) } : e)); }}>
                          <Text style={styles.stepperBtnText}>−</Text>
                        </TouchableOpacity>
                        <Text style={styles.stepperValue}>{ex.sets.length}</Text>
                        <TouchableOpacity style={styles.stepperBtn} onPress={() => setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, sets: [...e.sets, { weight: '', reps: e.targetReps || '', modifier: null }] } : e))}>
                          <Text style={styles.stepperBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                      <View style={styles.targetRepsRow}>
                        <Text style={styles.targetRepsLabel}>Target reps</Text>
                        <TextInput
                          style={styles.targetRepsInput}
                          placeholder="e.g. 8"
                          placeholderTextColor="#A0A0A0"
                          value={ex.targetReps}
                          onChangeText={(v) => setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, targetReps: v } : e))}
                          keyboardType="number-pad"
                        />
                      </View>
                    </View>
                    <View style={styles.templateSetModifiersRow}>
                      {ex.sets.map((set, si) => (
                        <View key={si} style={styles.templateSetModifierRow}>
                          <Text style={styles.templateSetModifierLabel}>Set {si + 1}</Text>
                          <TouchableOpacity
                            style={[styles.modifierChip, set.modifier === 'drop' && styles.modifierChipDrop, set.modifier === 'negative' && styles.modifierChipNegative]}
                            onPress={() => {
                              const next = set.modifier === null ? 'drop' : set.modifier === 'drop' ? 'negative' : null;
                              setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, sets: e.sets.map((s, j) => j === si ? { ...s, modifier: next } : s) } : e));
                            }}
                          >
                            <Text style={[styles.modifierChipText, (set.modifier === 'drop' || set.modifier === 'negative') && styles.modifierChipTextActive]}>
                              {set.modifier === 'drop' ? 'Drop' : set.modifier === 'negative' ? 'Negative' : 'Normal'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                  {idx < editingExercises.length - 1 && (
                    <View style={styles.supersetLinkRow}>
                      <TouchableOpacity
                        onPress={() => setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, isSupersetWithNext: !e.isSupersetWithNext } : e))}
                        style={[styles.supersetLinkBtn, ex.isSupersetWithNext && styles.supersetLinkBtnActive]}
                      >
                        <Ionicons name={ex.isSupersetWithNext ? 'link' : 'link-outline'} size={22} color={ex.isSupersetWithNext ? THEME.accent : '#888'} />
                        <Text style={[styles.supersetLinkText, ex.isSupersetWithNext && styles.supersetLinkTextActive]}>
                          {ex.isSupersetWithNext ? 'Linked (superset)' : 'Link with next'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </Fragment>
              ))}
              <View style={styles.modalAddSection}>
                <Text style={styles.modalSectionLabel}>Add exercise</Text>
                <View style={styles.modalAddRow}>
                  <TextInput
                    style={styles.modalAddInput}
                    placeholder="New exercise name"
                    placeholderTextColor="#A0A0A0"
                    value={newExerciseName}
                    onChangeText={setNewExerciseName}
                  />
                  <TouchableOpacity style={styles.modalAddBtn} onPress={() => {
                    if (newExerciseName.trim()) {
                      setEditingExercises(prev => [...prev, { exercise: newExerciseName.trim(), note: '', targetReps: '', sets: [{ weight: '', reps: '', modifier: null }, { weight: '', reps: '', modifier: null }, { weight: '', reps: '', modifier: null }], isSupersetWithNext: false }]);
                      setNewExerciseName('');
                    }
                  }}>
                    <Text style={styles.modalAddBtnText}>+ Add exercise</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </View>
        </Modal>

        {showShoulderCard && !shoulderWarmupDone && (
          <View style={styles.shoulderCard}>
            <Text style={styles.shoulderCardText}>🔥 Shoulder Warmup Reminder</Text>
            <TouchableOpacity
              style={styles.shoulderCardDoneBtn}
              onPress={() => setShoulderWarmupDone(true)}
            >
              <Ionicons name="checkmark-circle" size={24} color={THEME.accent} />
              <Text style={styles.shoulderCardDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {exerciseBlocks.map((block) => {
          const isSuperset = block.indices.length === 2;
          return (
          <View key={isSuperset ? `ss-${block.indices[0]}` : `ex-${block.indices[0]}`} style={isSuperset ? styles.supersetGroup : undefined}>
            {isSuperset && <Text style={styles.supersetTag}>SUPERSET</Text>}
            {block.indices.map((exIdx) => {
          const item = exercisesToShow[exIdx];
          const displayName = substitutions[item.exercise] ?? item.exercise;
          const isSubbed = !!substitutions[item.exercise];
          const warmUpCount = (injectedWarmups[item.exercise] || []).length;
          const workingSetCount = isSubbed ? (subSetCount[item.exercise] ?? 1) : (item.sets || []).length;
          const effectiveSetIndices = Array.from({ length: warmUpCount + workingSetCount }, (_, i) => i);
          const isFirstExercise = exIdx === 0;
          const canGenerateWarmups = isFirstExercise && item.exercise !== 'Marty St Louis' && !injectedWarmups[item.exercise];
          return (
          <View key={`ex-card-${exIdx}`} style={[styles.exCard, isSuperset && styles.exCardInSuperset]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[styles.exName, { flex: 1 }]} numberOfLines={2}>{displayName}{isSubbed ? ` (sub: ${item.exercise})` : ''}{getExerciseSetSummary(item, isSubbed)}</Text>
              {canGenerateWarmups && (
                <TouchableOpacity style={styles.generateWarmupsBtn} onPress={() => generateWarmupsForExercise(item)}>
                  <Text style={styles.generateWarmupsBtnText}>Generate Warm-ups</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.subBtn, isSubbed && styles.subBtnActive]}
                onPress={() => {
                  if (substitutions[item.exercise]) {
                    setSubstitutions(s => { const n = { ...s }; delete n[item.exercise]; return n; });
                    setSubSetCount(c => { const n = { ...c }; delete n[item.exercise]; return n; });
                  } else {
                    setSubbingFor(item.exercise);
                  }
                }}
              >
                <Text style={styles.subBtnText}>{isSubbed ? 'Clear' : 'Sub'}</Text>
              </TouchableOpacity>
            </View>
            {subbingFor === item.exercise && (
              <View style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <TextInput
                    style={[styles.noteInput, { flex: 1, minHeight: 36 }]}
                    placeholder="Replacement (today only)"
                    placeholderTextColor="#A0A0A0"
                    value={subInputValue}
                    onChangeText={setSubInputValue}
                  />
                  <TouchableOpacity style={styles.doneBtn} onPress={() => {
                    if (subInputValue.trim()) {
                      setSubstitutions(s => ({ ...s, [item.exercise]: subInputValue.trim() }));
                      setSubSetCount(c => ({ ...c, [item.exercise]: 1 }));
                      setInputs(prev => ({ ...prev, [item.exercise]: { sets: { 0: { weight: '', reps: '', modifier: subModifier } }, cues: prev[item.exercise]?.cues ?? '' } }));
                    }
                    setSubbingFor(null);
                    setSubInputValue('');
                    setSubModifier(null);
                  }}>
                    <Text style={styles.doneBtnText}>Apply</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.doneBtn} onPress={() => { setSubbingFor(null); setSubInputValue(''); setSubModifier(null); }}>
                    <Text style={styles.doneBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.templateSetModifierLabel}>Set 1</Text>
                  <TouchableOpacity
                    style={[styles.modifierChip, subModifier === 'drop' && styles.modifierChipDrop, subModifier === 'negative' && styles.modifierChipNegative]}
                    onPress={() => setSubModifier(s => s === null ? 'drop' : s === 'drop' ? 'negative' : null)}
                  >
                    <Text style={[styles.modifierChipText, (subModifier === 'drop' || subModifier === 'negative') && styles.modifierChipTextActive]}>
                      {subModifier === 'drop' ? 'Drop' : subModifier === 'negative' ? 'Negative' : 'Normal'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            {(lastLogByExercise[item.exercise]?.log?.notes || item.note) && !isSubbed ? <Text style={styles.prevNote}>“{lastLogByExercise[item.exercise]?.log?.notes || item.note}”</Text> : null}
            {effectiveSetIndices.map((setIdx) => {
              const isWarmup = setIdx < warmUpCount;
              const isMarty = item.exercise === 'Marty St Louis';
              const setModifier = getSetModifier(item, setIdx, warmUpCount, isSubbed);
              const isSpecialSet = setModifier === 'drop' || setModifier === 'negative';
              const specialSetDone = isSpecialSet && (inputs[item.exercise]?.sets?.[setIdx]?.reps === '✓');
              const isBWChecked = inputs[item.exercise]?.sets?.[setIdx]?.weight === 'BW';
              const prevSet = isWarmup
                ? injectedWarmups[item.exercise][setIdx]
                : (lastLogByExercise[item.exercise]?.sets || [])[setIdx - warmUpCount] ?? null;
              const setLabel = isWarmup ? `W${setIdx + 1}` : `SET ${setIdx - warmUpCount + 1}`;
              const isActiveSet = globalActivePosition?.exIdx === exIdx && globalActivePosition?.setIdx === setIdx;
              const isPrSet = !!prSetKeys[`${item.exercise}-${setIdx}`];

              return (
                <View key={`set-row-${exIdx}-${setIdx}`} style={[styles.setRowContainer, isActiveSet && styles.activeSetRow, isWarmup && styles.warmupSetRow, isPrSet && styles.prSetRow]}>
                  <View style={styles.setLabelRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.setNumber, isWarmup && styles.warmupSetLabel, isActiveSet && styles.setNumberActive]}>{setLabel}</Text>
                      {!isWarmup && (
                        <TouchableOpacity
                          style={[styles.modifierChip, setModifier === 'drop' && styles.modifierChipDrop, setModifier === 'negative' && styles.modifierChipNegative]}
                          onPress={() => {
                            const next = setModifier === null ? 'drop' : setModifier === 'drop' ? 'negative' : null;
                            updateSetInput(item.exercise, setIdx, 'modifier', next);
                          }}
                        >
                          <Text style={[styles.modifierChipText, setModifier === 'drop' && styles.modifierChipTextActive, setModifier === 'negative' && styles.modifierChipTextActive]}>
                            {setModifier === 'drop' ? 'Drop' : setModifier === 'negative' ? 'Neg' : 'Normal'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {isPrSet && <Text style={styles.prBadge}>👑 NEW PR</Text>}
                    </View>
                    {!isWarmup && overloadNudgeMap[item.exercise] ? (
                      <Text style={styles.lastStatsOverload}>Target: {overloadNudgeMap[item.exercise].targetWeight} lbs 📈</Text>
                    ) : prevSet ? (
                      <Text style={styles.lastStats}>Last: {prevSet.weight || 'BW'} × {prevSet.reps}</Text>
                    ) : null}
                  </View>
                  <View style={styles.inputGroup}>
                    {isSpecialSet ? (
                      <View style={styles.specialSetBtnWrapper}>
                        <TouchableOpacity
                          style={[styles.specialSetBtn, specialSetDone && styles.specialSetBtnDone]}
                          onPress={() => {
                            if (specialSetDone) return;
                            updateSetInput(item.exercise, setIdx, 'reps', '✓');
                            updateSetInput(item.exercise, setIdx, 'weight', '');
                            if (!item.isSupersetWithNext) startRestTimer();
                          }}
                          disabled={specialSetDone}
                        >
                          <Text style={[styles.specialSetBtnText, specialSetDone && styles.specialSetBtnTextDone]}>{specialSetDone ? '✓ Done' : setModifier === 'drop' ? 'Complete Dropset' : 'Complete Negative'}</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <>
                    {!isMarty && (
                      <View style={styles.lbsInputWrapper}>
                        <TextInput 
                          style={styles.dualInput} 
                          placeholder="Lbs" 
                          placeholderTextColor="#A0A0A0" 
                          keyboardType="number-pad"
                          value={inputs[item.exercise]?.sets?.[setIdx]?.weight || ''}
                          onChangeText={v => updateSetInput(item.exercise, setIdx, 'weight', v)}
                        />
                        {showBWButton(item.exercise) && (
                          <TouchableOpacity style={[styles.bwBadge, isBWChecked && styles.bwBadgeActive]} onPress={() => updateSetInput(item.exercise, setIdx, 'weight', isBWChecked ? '' : 'BW')}>
                            <Text style={[styles.bwBadgeText, isBWChecked && styles.bwBadgeTextActive]}>BW</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                    <View style={styles.repsInputWrapper}>
                      <TextInput 
                        style={[styles.dualInput, isMarty && styles.dualInputFullWidth]} 
                        placeholder={item.targetReps ? `Reps (${item.targetReps})` : 'Reps'} 
                        placeholderTextColor="#A0A0A0" 
                        keyboardType="number-pad"
                        value={inputs[item.exercise]?.sets?.[setIdx]?.reps || ''}
                        onChangeText={v => updateSetInput(item.exercise, setIdx, 'reps', v)}
                      onBlur={() => {
                        setTimeout(() => {
                          const inp = inputsRef.current;
                          const w = inp[item.exercise]?.sets?.[setIdx]?.weight;
                          const r = inp[item.exercise]?.sets?.[setIdx]?.reps;
                          const hasWeight = w != null && String(w).trim() !== '';
                          const hasReps = r != null && String(r).trim() !== '';
                          if (hasWeight && hasReps && !item.isSupersetWithNext) startRestTimer();
                          const weightNum = w === 'BW' || !w ? 0 : parseFloat(String(w).replace(/[^0-9.]/g, ''), 10) || 0;
                          const allTimeMax = maxWeightByExercise[normalizeExerciseName(item.exercise)] ?? 0;
                          const prKey = `${item.exercise}-${setIdx}`;
                          if (weightNum > 0 && weightNum >= allTimeMax && !prSetKeysRef.current[prKey]) {
                            setPrSetKeys((prev) => ({ ...prev, [prKey]: true }));
                            if (Platform.OS !== 'web') Vibration.vibrate([0, 100, 50, 100]);
                          }
                        }, 50);
                      }}
                    />
                    </View>
                    </>
                    )}
                  </View>
                </View>
              );
            })}
            {isSubbed && (
              <View style={styles.addRemoveSetRow}>
                <TouchableOpacity style={styles.addRemoveSetBtn} onPress={() => setSubSetCount(c => ({ ...c, [item.exercise]: (c[item.exercise] ?? 1) + 1 }))}>
                  <Text style={styles.addRemoveSetText}>+ Add set</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.addRemoveSetBtn, (subSetCount[item.exercise] ?? 1) <= 1 && styles.addRemoveSetBtnDisabled]}
                  onPress={() => {
                    const n = subSetCount[item.exercise] ?? 1;
                    if (n <= 1) return;
                    setSubSetCount(c => ({ ...c, [item.exercise]: n - 1 }));
                    setInputs(prev => {
                      const sets = { ...prev[item.exercise]?.sets };
                      delete sets[n - 1];
                      return { ...prev, [item.exercise]: { ...prev[item.exercise], sets } };
                    });
                  }}
                  disabled={(subSetCount[item.exercise] ?? 1) <= 1}
                >
                  <Text style={styles.addRemoveSetText}>− Remove set</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* Notes input for this exercise */}
            <TextInput
              style={styles.noteInput}
              placeholder="Add notes for this exercise..."
              placeholderTextColor="#A0A0A0"
              keyboardType="default"
              returnKeyType="done"
              multiline
              value={inputs[item.exercise]?.cues || ''}
              onChangeText={v =>
                setInputs(prev => ({
                  ...prev,
                  [item.exercise]: {
                    ...prev[item.exercise],
                    cues: v,
                    sets: prev[item.exercise]?.sets || {},
                  },
                }))
              }
            />
          </View>
          );
            })}
          </View>
          );
        })}
        <TouchableOpacity style={styles.finishBtn} onPress={() => {
          const incomplete = countIncompleteSets();
          if (incomplete > 0) {
            setIncompleteSetCount(incomplete);
            setFinishEarlyModalVisible(true);
          } else {
            save(false);
          }
        }}>
          <Text style={styles.finishText}>FINISH ✓</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal
        visible={finishEarlyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFinishEarlyModalVisible(false)}
      >
        <Pressable style={styles.finishEarlyOverlay} onPress={() => setFinishEarlyModalVisible(false)}>
          <Pressable style={styles.finishEarlyCard} onPress={() => {}}>
            <Text style={styles.finishEarlyTitle}>Finish Early?</Text>
            <Text style={styles.finishEarlyBody}>
              You still have {incompleteSetCount} set{incompleteSetCount !== 1 ? 's' : ''} left. Do you want to skip them and save your progress, or go back and finish?
            </Text>
            <View style={styles.finishEarlyActions}>
              <TouchableOpacity style={styles.finishEarlyPrimaryBtn} onPress={() => setFinishEarlyModalVisible(false)}>
                <Text style={styles.finishEarlyPrimaryBtnText}>Keep Grinding</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.finishEarlySecondaryBtn} onPress={() => { setFinishEarlyModalVisible(false); save(false, true); }}>
                <Text style={styles.finishEarlySecondaryBtnText}>Skip & Save</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      </View>
    </KeyboardAvoidingView>
  );
};

const TodayScreen = React.memo(TodayScreenInner);

// Each lift: include = phrases that count (typo-friendly); exclude = variations that must NOT count.
// Tuned from workout_history.csv so DB/BB and variations don’t mix (e.g. DB curls vs BB curls, bench vs incline).
const LIFT_KEYWORDS = [
  {
    key: 'Bench Press',
    include: ['bench press', 'bb bench', 'bench', 'benc'],
    exclude: ['db bench', 'dumbbell bench', 'incline', 'ab bench', 'bench fly', 'bench flies', 'reverse bench'],
  },
  {
    key: 'Squat',
    include: ['squat', 'squats'],
    exclude: ['slant', 'hack squat', 'goblet', 'front squat', 'front squats', 'split squat', 'bulgarian', 'leg press', 'pistol', 'smith squat', 'sissy', 'belt squat', 'hold squat', 'seated squat', 'squat jump'],
  },
  {
    key: 'DB Curls',
    include: ['db curl', 'dumbbell curl', 'curls', 'regular curl'],
    exclude: ['stretch', 'stretch curl', 'bb curl', 'barbell curl', 'hammer curl', 'cable curl', 'preacher', 'incline curl', 'concentration curl', 'ez bar', 'rope curl', 'overhead bar curl', 'wide curl', 'leg curl'],
  },
  {
    key: 'Deadlift',
    include: ['deadlift', 'dead lift', 'deadlifts'],
    exclude: ['romanian', 'rdl', 'stiff leg', 'stiff-leg'],
  },
  {
    key: 'Incline Bench',
    include: ['incline bench', 'incline press', 'incline bb', 'bb incline', 'incline bench bb'],
    exclude: ['db incline', 'dumbbell incline', 'incline db', 'incline press machine', 'incline machine', 'incline chest machine', 'incline chest press'],
  },
  {
    key: 'BB Row',
    include: ['barbell row', 'bb row', 'bb standing row', 'bent row', 'pendlay row'],
    exclude: ['db row', 'dumbbell row', 'cable row', 't-bar', 'tbar'],
  },
];

function matchesLift(name, lift) {
  const n = name.toLowerCase().trim();
  const included = (lift.include || []).some(phrase => n.includes(phrase.toLowerCase()));
  const excluded = (lift.exclude || []).some(phrase => n.includes(phrase.toLowerCase()));
  return included && !excluded;
}

function getWeightFromLog(log) {
  if (log == null) return 0;
  if (typeof log.weight === 'number' && log.weight > 0) return log.weight;
  const fromNotes = getWeight(String(log.notes || log.note || ''));
  if (fromNotes > 0) return fromNotes;
  const firstSet = log.sets?.[0];
  if (firstSet && firstSet.weight != null && firstSet.weight !== 'Bodyweight') {
    const w = Number(firstSet.weight);
    return isNaN(w) ? 0 : w;
  }
  return 0;
}

// Epley formula: 1RM ≈ weight * (1 + reps/30). Returns null if reps missing.
function estimated1RM(weight, reps) {
  if (weight <= 0 || reps == null || reps <= 0) return null;
  const r = Number(reps);
  if (isNaN(r)) return null;
  return Math.round(weight * (1 + r / 30));
}

// Build a short "225×5, 225×4" summary from log for tooltip.
function getSetsSummary(log) {
  const notes = String(log.notes || log.note || '').trim();
  if (notes) return notes;
  if (log.sets?.length) return log.sets.map(s => `${s.weight ?? '?'}×${s.reps ?? '?'}`).join(', ');
  return '';
}

// Parse notes/sets into best weight and best estimated 1RM for that log (same log only, so 1RM aligns with weight).
function getBestWeightAnd1RM(log) {
  let bestWeight = getWeightFromLog(log);
  let best1RM = null;
  const notes = String(log.notes || log.note || '');
  const sets = notes.split(',').map(s => s.trim());
  for (const set of sets) {
    const match = set.match(/(\d+)\s*x\s*(\d+)/i);
    if (match) {
      const w = parseInt(match[1], 10);
      const r = parseInt(match[2], 10);
      if (w > 0 && r > 0) {
        if (w > bestWeight) bestWeight = w;
        const oneRM = estimated1RM(w, r);
        if (oneRM != null && (best1RM == null || oneRM > best1RM)) best1RM = oneRM;
      }
    }
  }
  if (log.sets?.length) {
    for (const s of log.sets) {
      const w = s.weight != null && s.weight !== 'Bodyweight' ? Number(s.weight) : 0;
      const r = s.reps != null ? Number(s.reps) : 0;
      if (w > 0 && r > 0) {
        if (w > bestWeight) bestWeight = w;
        const oneRM = estimated1RM(w, r);
        if (oneRM != null && (best1RM == null || oneRM > best1RM)) best1RM = oneRM;
      }
    }
  }
  return { weight: bestWeight, est1RM: best1RM };
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// X-axis: month + year (e.g. "Jan 2025") so the timeline is easy to read at a glance.
function formatChartDateAxis(dateStr) {
  const t = parseWorkoutDate(dateStr);
  if (!t) return dateStr;
  const d = new Date(t);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// Tooltip: full date with year (e.g. "Jan 12, 2025") when tapping a point.
function formatChartDateTooltip(dateStr) {
  const t = parseWorkoutDate(dateStr);
  if (!t) return dateStr;
  const d = new Date(t);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const ProgressTimeline = ({ history }) => {
  const [selectedLift, setSelectedLift] = useState(LIFT_KEYWORDS[0].key);
  const [chartRange, setChartRange] = useState('1Y'); // '1Y' | 'Lifetime'

  const chartData = useMemo(() => {
    const match = LIFT_KEYWORDS.find(({ key }) => key === selectedLift);
    if (!match) return [];
    const entries = [];
    (history || []).forEach((log) => {
      const name = (log.exercise || '').toLowerCase();
      if (!name || !matchesLift(name, match)) return;
      const { weight, est1RM } = getBestWeightAnd1RM(log);
      if (weight <= 0) return;
      const setsSummary = getSetsSummary(log);
      entries.push({ date: log.date, weight, est1RM, setsSummary });
    });
    const byDate = {};
    entries.forEach(e => {
      if (!byDate[e.date] || e.weight > byDate[e.date].weight) {
        byDate[e.date] = { date: e.date, weight: e.weight, est1RM: e.est1RM, setsSummary: e.setsSummary };
      }
    });
    let dates = Object.keys(byDate).sort((a, b) => parseWorkoutDate(a) - parseWorkoutDate(b));
    if (chartRange === '1Y') {
      const oneYearAgo = Date.now() - 365.25 * 24 * 60 * 60 * 1000;
      dates = dates.filter(d => parseWorkoutDate(d) >= oneYearAgo);
    }
    return dates.map(d => {
      const row = byDate[d];
      return row ? { ...row, timestamp: parseWorkoutDate(d) } : null;
    }).filter(Boolean);
  }, [history, selectedLift, chartRange]);

  const { timeDomain, xTicks } = useMemo(() => {
    if (!chartData.length) return { timeDomain: [0, 1], xTicks: [] };
    const minT = chartData[0].timestamp;
    const maxT = chartData[chartData.length - 1].timestamp;
    const minD = new Date(minT);
    const maxD = new Date(maxT);
    const padding = (maxT - minT) * 0.02 || 86400000 * 7;
    const domain = [minT - padding, maxT + padding];
    let ticks = [];
    if (chartRange === '1Y') {
      let d = startOfMonth(minD);
      const end = addMonths(startOfMonth(maxD), 1);
      while (d.getTime() <= end.getTime()) {
        if (d.getTime() >= minT && d.getTime() <= maxT) ticks.push(d.getTime());
        d = addMonths(d, 1);
      }
      while (ticks.length > 7) ticks = ticks.filter((_, i) => i % 2 === 0);
    } else {
      let d = startOfYear(minD);
      const end = addYears(startOfYear(maxD), 1);
      while (d.getTime() <= end.getTime()) {
        if (d.getTime() >= minT && d.getTime() <= maxT) ticks.push(d.getTime());
        d = addYears(d, 1);
      }
      while (ticks.length > 7) ticks = ticks.filter((_, i) => i % 2 === 0);
    }
    return { timeDomain: domain, xTicks: ticks };
  }, [chartData, chartRange]);

  if (Platform.OS !== 'web') {
    return <View style={styles.chartSection}><Text style={styles.noDataText}>Weight-over-time chart is on the web version.</Text></View>;
  }
  const chartFont = { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontWeight: 'bold' };
  try {
    const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = require('recharts');
    return (
      <View style={styles.chartSection}>
        <View style={styles.chartSectionInner}>
          <Text style={[styles.exName, chartFont]}>{selectedLift} – weight & progress</Text>
          <View style={styles.liftPicker}>
            {LIFT_KEYWORDS.map(({ key }) => (
              <TouchableOpacity
                key={key}
                style={[styles.pickerBtn, selectedLift === key && { borderColor: THEME.accent, backgroundColor: THEME.highlight }]}
                onPress={() => setSelectedLift(key)}
              >
                <Text style={[styles.pickerText, selectedLift === key && { color: THEME.accent }, chartFont]}>{key.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {!chartData.length ? (
          <Text style={[styles.noDataText, chartFont]}>No data for {selectedLift}. Log weight and reps to see progress and est. 1RM.</Text>
        ) : (
          <>
            <View style={styles.chartEdgeToEdge}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={chartData}
                  margin={{ top: 16, right: 28, left: 28, bottom: 28 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={timeDomain}
                    ticks={xTicks}
                    tickFormatter={(ts) => chartRange === '1Y' ? format(ts, 'MMM') : format(ts, 'yyyy')}
                    axisLine={{ stroke: '#333' }}
                    tickLine={false}
                    tick={{ fill: '#aaa', fontSize: 11, ...chartFont }}
                    interval={0}
                    allowDataOverflow={false}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    width={36}
                    tick={{ fill: '#aaa', fontSize: 11, ...chartFont }}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload;
                      const dateLabel = p.date ? formatChartDateTooltip(p.date) : (p.timestamp ? format(p.timestamp, 'MMM d, yyyy') : '');
                      return (
                        <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', backgroundColor: '#0a0a0a', border: '1px solid #333', borderRadius: 10, padding: '12px 14px', minWidth: 140, boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                          <div style={{ color: '#CCFF00', fontSize: 11, fontWeight: '900', letterSpacing: 0.5, marginBottom: 8 }}>{dateLabel}</div>
                          <div style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>Weight: {p.weight} lb</div>
                          {p.est1RM != null && <div style={{ color: '#e0e0e0', fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>Est. 1RM: {p.est1RM} lb</div>}
                          {p.setsSummary ? <div style={{ color: '#888', fontSize: 12, fontWeight: '600', marginTop: 6, borderTop: '1px solid #222', paddingTop: 6 }}>Sets: {p.setsSummary}</div> : null}
                        </div>
                      );
                    }}
                  />
                  <Line type="monotone" dataKey="weight" stroke="#CCFF00" dot={{ r: 3, fill: '#CCFF00', strokeWidth: 0 }} connectNulls strokeWidth={2} />
                  <Line type="monotone" dataKey="est1RM" stroke="#e0e0e0" dot={{ r: 3, fill: '#e0e0e0', strokeWidth: 0 }} connectNulls strokeDasharray="5 3" strokeWidth={2} name="Est. 1RM" />
                </LineChart>
              </ResponsiveContainer>
            </View>
            <View style={[styles.chartLegendRow, styles.chartSectionInner]}>
              <View style={styles.rangePicker}>
                <TouchableOpacity style={[styles.pickerBtn, chartRange === '1Y' && styles.rangeBtnActive]} onPress={() => setChartRange('1Y')}>
                  <Text style={[styles.pickerText, chartRange === '1Y' && styles.rangeBtnTextActive, chartFont]}>1Y</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.pickerBtn, chartRange === 'Lifetime' && styles.rangeBtnActive]} onPress={() => setChartRange('Lifetime')}>
                  <Text style={[styles.pickerText, chartRange === 'Lifetime' && styles.rangeBtnTextActive, chartFont]}>Lifetime</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.chartLegend}>
                <View style={styles.chartLegendItem}><View style={[styles.chartLegendDot, { backgroundColor: '#CCFF00' }]} /><Text style={[styles.chartLegendText, chartFont]}>Weight</Text></View>
                <View style={styles.chartLegendItem}><View style={[styles.chartLegendDot, { backgroundColor: '#e0e0e0' }]} /><Text style={[styles.chartLegendText, chartFont]}>Est. 1RM</Text></View>
              </View>
            </View>
          </>
        )}
      </View>
    );
  } catch (e) {
    return <View style={styles.chartSection}><Text style={styles.noDataText}>Chart unavailable</Text></View>;
  }
};

const HistoryScreenInner = ({ history }) => {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    const filtered = history.filter(h => h.date && searchMatchesLog(search, h));
    const map = {};
    filtered.forEach((h) => {
      const sessionKey = h.completedAt ? `${h.date}|${h.completedAt}` : `${h.date}|legacy`;
      if (!map[sessionKey]) map[sessionKey] = { date: h.date, completedAt: h.completedAt, data: [] };
      map[sessionKey].data.push(h);
    });
    const list = Object.values(map);
    list.sort((a, b) => {
      const timeA = a.completedAt ? new Date(a.completedAt).getTime() : parseWorkoutDate(a.date);
      const timeB = b.completedAt ? new Date(b.completedAt).getTime() : parseWorkoutDate(b.date);
      return timeB - timeA;
    });
    return list;
  }, [history, search]);

  return (
    <View style={{ flex: 1 }}>
      <TextInput style={styles.searchBar} placeholder="Search history..." placeholderTextColor="#A0A0A0" onChangeText={setSearch} />
      <FlatList
        data={sessions}
        keyExtractor={(item, index) => `hist-${item.date}-${item.completedAt || 'legacy'}-${index}`}
        renderItem={({ item }) => (
          <View style={styles.sessionCard}>
            <Text style={styles.sessionHeader}>
              {item.date.toUpperCase()}
              {item.completedAt ? ` · ${format(new Date(item.completedAt), 'h:mm a')}` : ''}
              {item.data?.[0]?.type ? ` · ${item.data[0].type.toUpperCase()}` : ''}
            </Text>
            {item.data.map((log, i) => (
              <View key={i} style={styles.logLine}>
                <Text style={styles.logExercise}>{log.exercise}</Text>
                <Text style={styles.logNotes}>{log.notes || (log.sets ? log.sets.map(s => `${s.weight || 'BW'}x${s.reps}`).join(', ') : '')}</Text>
              </View>
            ))}
          </View>
        )}
        contentContainerStyle={styles.scroll}
        ListHeaderComponent={<ProgressTimeline history={history} />}
      />
    </View>
  );
};

const HistoryScreen = React.memo(HistoryScreenInner);

export default function App() {
  const [tab, setTab] = useState('Today');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [suggestedWorkout, setSuggestedWorkout] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [abTemplates, setAbTemplates] = useState(DEFAULT_AB_TEMPLATES);
  const [lastAbWorkout, setLastAbWorkout] = useState(null); // { date, type } or null
  const [showSuccessScreen, setShowSuccessScreen] = useState(false);
  const [lastCompletedAt, setLastCompletedAt] = useState(null);
  const [lastCompletedWorkout, setLastCompletedWorkout] = useState(null);
  const [totalTonnage, setTotalTonnage] = useState(null);
  const [todayProgress, setTodayProgress] = useState(null);
  const [inProgressSnapshot, setInProgressSnapshot] = useState(null); // restored workout-in-progress for today (survives reload)
  const [restTimerSeconds, setRestTimerSeconds] = useState(null);
  const [isTimerMuted, setIsTimerMuted] = useState(false);
  const restTimerRef = useRef(null);
  const restTimerIntervalRef = useRef(null);
  const isTimerMutedRef = useRef(false);
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const TAB_BAR_HEIGHT = 52;

  const stickyBottomAnim = useRef(new Animated.Value(TAB_BAR_HEIGHT)).current;

  const keyboardEasingRef = useRef(Easing.bezier(0.25, 0.1, 0.25, 1));
  useEffect(() => {
    if (typeof Keyboard === 'undefined' || typeof Keyboard.addListener !== 'function') return;
    const easing = keyboardEasingRef.current;
    const showSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      const h = e.endCoordinates?.height ?? 0;
      const duration = e.duration ?? (Platform.OS === 'ios' ? 250 : 100);
      Animated.timing(stickyBottomAnim, { toValue: h, duration, easing, useNativeDriver: false }).start();
    });
    const hideSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (e) => {
      const duration = e.duration ?? (Platform.OS === 'ios' ? 250 : 100);
      Animated.timing(stickyBottomAnim, { toValue: TAB_BAR_HEIGHT, duration, easing, useNativeDriver: false }).start();
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, [stickyBottomAnim]);

  useEffect(() => { isTimerMutedRef.current = isTimerMuted; }, [isTimerMuted]);

  const cancelRestTimer = useCallback(() => {
    if (restTimerIntervalRef.current) {
      clearInterval(restTimerIntervalRef.current);
      restTimerIntervalRef.current = null;
    }
    stopTimerSpeech();
    restTimerRef.current = null;
    setRestTimerSeconds(null);
  }, []);

  const startRestTimer = useCallback(() => {
    if (restTimerIntervalRef.current) {
      clearInterval(restTimerIntervalRef.current);
      restTimerIntervalRef.current = null;
    }
    restTimerRef.current = 60;
    setRestTimerSeconds(60);
    restTimerIntervalRef.current = setInterval(() => {
      restTimerRef.current = restTimerRef.current - 1;
      const s = restTimerRef.current;
      if (!isTimerMutedRef.current) {
        if (s === 30) speakTimer('30 seconds');
        if (s === 10) speakTimer('10 seconds');
      }
      if (s <= 0) {
        if (!isTimerMutedRef.current) {
          speakTimer('Time to lift!');
          if (Platform.OS !== 'web') Vibration.vibrate(400);
        }
        clearInterval(restTimerIntervalRef.current);
        restTimerIntervalRef.current = null;
        restTimerRef.current = null;
        setRestTimerSeconds(null);
        return;
      }
      if (tabRef.current === 'Today') setRestTimerSeconds(s);
    }, 1000);
  }, []);

  useEffect(() => {
    return () => { if (restTimerIntervalRef.current) clearInterval(restTimerIntervalRef.current); };
  }, []);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [stored, overridesStored, abTemplatesStored, lastAbStored, inProgressStored, absMigrationDone] = await Promise.all([
        AsyncStorage.getItem('workout_history'),
        AsyncStorage.getItem(OVERRIDES_KEY),
        AsyncStorage.getItem(AB_TEMPLATES_KEY),
        AsyncStorage.getItem(LAST_AB_WORKOUT_KEY),
        AsyncStorage.getItem(IN_PROGRESS_WORKOUT_KEY),
        AsyncStorage.getItem(ABS_SHOW_MIGRATION_KEY),
      ]);
      const parsedStored = stored ? JSON.parse(stored) : [];
      const userLogsOnly = Array.isArray(parsedStored) ? parsedStored.filter((log) => log.completedAt) : [];
      const normalizedSeed = seedData.map(normalizeHistoryLog);
      setHistory([...normalizedSeed, ...userLogsOnly]);
      setOverrides(overridesStored ? JSON.parse(overridesStored) : {});
      setAbTemplates(abTemplatesStored ? { ...DEFAULT_AB_TEMPLATES, ...JSON.parse(abTemplatesStored) } : DEFAULT_AB_TEMPLATES);
      if (!absMigrationDone) {
        await AsyncStorage.removeItem(LAST_AB_WORKOUT_KEY);
        await AsyncStorage.setItem(ABS_SHOW_MIGRATION_KEY, '1');
        setLastAbWorkout(null);
      } else {
        setLastAbWorkout(lastAbStored ? JSON.parse(lastAbStored) : null);
      }
      let restored = null;
      if (inProgressStored) {
        try {
          const parsed = JSON.parse(inProgressStored);
          const today = format(new Date(), 'MM/dd/yy');
          if (parsed.date === today && parsed.type && parsed.variation) restored = parsed;
          else await AsyncStorage.removeItem(IN_PROGRESS_WORKOUT_KEY);
        } catch (_) { await AsyncStorage.removeItem(IN_PROGRESS_WORKOUT_KEY); }
      }
      setInProgressSnapshot(restored);
    } catch (e) {
      setHistory(seedData.map(normalizeHistoryLog));
      setOverrides({});
      setAbTemplates(DEFAULT_AB_TEMPLATES);
      setLastAbWorkout(null);
      setInProgressSnapshot(null);
    } finally { setLoading(false); }
  };

  const onSaveOverrides = async (type, variation, exercises) => {
    const next = {
      ...overrides,
      [type]: {
        ...overrides[type],
        [variation]: { ...overrides[type]?.[variation], exercises },
      },
    };
    setOverrides(next);
    await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    if (loading) return;
    const setNext = async () => {
      try {
        const last = await AsyncStorage.getItem(LAST_WORKOUT_KEY);
        const lastObj = last ? JSON.parse(last) : null;
        const idx = lastObj ? WORKOUT_SEQUENCE.findIndex(w => w.type === lastObj.type && w.variation === lastObj.variation) : -1;
        const nextIdx = idx < 0 ? 0 : (idx + 1) % WORKOUT_SEQUENCE.length;
        setSuggestedWorkout(WORKOUT_SEQUENCE[nextIdx]);
      } catch (e) {
        setSuggestedWorkout(WORKOUT_SEQUENCE[0]);
      }
    };
    setNext();
  }, [loading]);

  const onFinish = async (logs, completed, abCompletion, options) => {
    const normalizedSeed = seedData.map(normalizeHistoryLog);
    const userLogs = history.filter((log) => log.completedAt);
    const updatedUserLogs = [...userLogs, ...logs];
    const updated = [...normalizedSeed, ...updatedUserLogs];
    setHistory(updated);
    await AsyncStorage.setItem('workout_history', JSON.stringify(updatedUserLogs));
    if (options?.abSkipped) {
      setLastAbWorkout(null);
      await AsyncStorage.removeItem(LAST_AB_WORKOUT_KEY);
    }
    if (completed) {
      setTotalTonnage(computeTonnageFromLogs(logs));
      await AsyncStorage.setItem(LAST_WORKOUT_KEY, JSON.stringify(completed));
      const idx = WORKOUT_SEQUENCE.findIndex(w => w.type === completed.type && w.variation === completed.variation);
      const nextIdx = (idx + 1) % WORKOUT_SEQUENCE.length;
      setSuggestedWorkout(WORKOUT_SEQUENCE[nextIdx]);
      setLastCompletedAt(logs[0]?.completedAt ?? null);
      setLastCompletedWorkout(completed);
      setShowSuccessScreen(true);
      // If this workout was from an override, set its source to today's date for next time
      if (logs.length > 0 && overrides[completed.type]?.[completed.variation]) {
        const completionDate = logs[0].date;
        const next = {
          ...overrides,
          [completed.type]: {
            ...overrides[completed.type],
            [completed.variation]: {
              ...overrides[completed.type][completed.variation],
              lastCompletedDate: completionDate,
            },
          },
        };
        setOverrides(next);
        await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
      }
    }
    // Ab cycle: update last ab date/type and overwrite that template's baseline with what user logged
    if (abCompletion && logs.length > 0) {
      const completionDate = logs[0].date;
      setLastAbWorkout({ date: completionDate, type: abCompletion.type });
      await AsyncStorage.setItem(LAST_AB_WORKOUT_KEY, JSON.stringify({ date: completionDate, type: abCompletion.type }));
      const nextAbTemplates = { ...abTemplates, [abCompletion.type]: { ...abTemplates[abCompletion.type], ...abCompletion.template } };
      setAbTemplates(nextAbTemplates);
      await AsyncStorage.setItem(AB_TEMPLATES_KEY, JSON.stringify(nextAbTemplates));
    }
    await AsyncStorage.removeItem(IN_PROGRESS_WORKOUT_KEY);
    setInProgressSnapshot(null);
  };

  const onUndoLastSession = async () => {
    if (lastCompletedAt == null || !lastCompletedWorkout) return;
    const normalizedSeed = seedData.map(normalizeHistoryLog);
    const userLogs = history.filter((log) => log.completedAt && log.completedAt !== lastCompletedAt);
    const filtered = [...normalizedSeed, ...userLogs];
    setHistory(filtered);
    await AsyncStorage.setItem('workout_history', JSON.stringify(userLogs));
    await AsyncStorage.setItem(LAST_WORKOUT_KEY, JSON.stringify(lastCompletedWorkout));
    setSuggestedWorkout(lastCompletedWorkout);
    setLastCompletedAt(null);
    setLastCompletedWorkout(null);
    setTotalTonnage(null);
    setShowSuccessScreen(false);
    if (overrides[lastCompletedWorkout.type]?.[lastCompletedWorkout.variation]) {
      const next = { ...overrides };
      const v = next[lastCompletedWorkout.type]?.[lastCompletedWorkout.variation];
      if (v) {
        const { lastCompletedDate, ...rest } = v;
        next[lastCompletedWorkout.type] = { ...next[lastCompletedWorkout.type], [lastCompletedWorkout.variation]: rest };
        setOverrides(next);
        await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
      }
    }
  };

  const onDismissSuccess = useCallback(() => setShowSuccessScreen(false), []);
  const onStartTwoADay = useCallback(() => setShowSuccessScreen(false), []);

  if (loading) return <View style={[styles.container, {justifyContent:'center'}]}><ActivityIndicator size="large" color="#CCFF00" /></View>;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <View style={{flex:1}}>{tab === 'Today' ? <TodayScreen history={history} onFinish={onFinish} initialType={suggestedWorkout?.type} initialVariation={suggestedWorkout?.variation} overrides={overrides} onSaveOverrides={onSaveOverrides} abTemplates={abTemplates} lastAbWorkout={lastAbWorkout} showSuccessScreen={showSuccessScreen} onDismissSuccess={onDismissSuccess} onStartTwoADay={onStartTwoADay} onUndoLastSession={onUndoLastSession} canUndo={!!lastCompletedAt} totalTonnage={totalTonnage} onProgressUpdate={setTodayProgress} startRestTimer={startRestTimer} cancelRestTimer={cancelRestTimer} initialInProgress={inProgressSnapshot} /> : <HistoryScreen history={history} />}</View>
        {tab === 'Today' && (restTimerSeconds != null || (todayProgress != null && todayProgress.completed >= 1)) ? (
          <Animated.View style={[styles.stickyBottomWrap, { bottom: stickyBottomAnim }]}>
            {restTimerSeconds != null ? (
              <View style={styles.restTimerBar}>
                <Text style={styles.restTimerText}>{`${Math.floor(restTimerSeconds / 60)}:${String(restTimerSeconds % 60).padStart(2, '0')}`}</Text>
                <View style={styles.restTimerButtons}>
                  <TouchableOpacity style={styles.restTimerMuteBtn} onPress={() => setIsTimerMuted(m => !m)}>
                    <Ionicons name={isTimerMuted ? 'volume-mute' : 'volume-high'} size={22} color={isTimerMuted ? '#888' : THEME.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.restTimerBtn} onPress={() => {
                    const next = Math.max(0, restTimerSeconds - 30);
                    restTimerRef.current = next;
                    setRestTimerSeconds(next > 0 ? next : null);
                    if (next <= 0) {
                      if (!isTimerMutedRef.current) { speakTimer('Time to lift!'); if (Platform.OS !== 'web') Vibration.vibrate(400); }
                      cancelRestTimer();
                    }
                  }}>
                    <Text style={styles.restTimerBtnText}>−30s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.restTimerBtn} onPress={() => { restTimerRef.current = restTimerSeconds + 30; setRestTimerSeconds(restTimerSeconds + 30); }}>
                    <Text style={styles.restTimerBtnText}>+30s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.restTimerBtn, styles.restTimerSkipBtn]} onPress={cancelRestTimer}>
                    <Text style={styles.restTimerSkipBtnText}>Skip</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
            {todayProgress != null && todayProgress.completed >= 1 ? (
              <>
                <View style={styles.progressBarStickyWrap}>
                  <View style={styles.progressBarStickyRow}>
                    <Text style={[styles.progressBarStickyText, todayProgress.isComplete && styles.progressBarTextComplete]} numberOfLines={1}>
                      {todayProgress.isComplete ? 'Done' : `${todayProgress.pct}% Complete`}
                    </Text>
                    <View style={[styles.progressBarTrack, todayProgress.isComplete && styles.progressBarTrackComplete, styles.progressBarTrackSticky]}>
                      <View style={[styles.progressBarFill, { width: `${todayProgress.pct}%` }, todayProgress.isComplete && styles.progressBarFillComplete]} />
                    </View>
                  </View>
                </View>
                <View style={styles.progressBarDivider} />
              </>
            ) : null}
          </Animated.View>
        ) : null}
        <View style={styles.tabBar}>
          <TouchableOpacity onPress={() => setTab('Today')} style={styles.tabItem}><Text style={[styles.tabText, tab==='Today' && {color: THEME.accent}]}>TODAY</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setTab('Stats')} style={styles.tabItem}><Text style={[styles.tabText, tab==='Stats' && {color: THEME.accent}]}>HISTORY</Text></TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  successContainer: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  successTitle: { color: '#fff', fontSize: 28, fontWeight: '900', marginBottom: 8 },
  successMessage: { color: THEME.dim, fontSize: 16, marginBottom: 16 },
  successTonnageBlock: { backgroundColor: '#111', paddingVertical: 16, paddingHorizontal: 20, borderRadius: 12, marginBottom: 24, borderWidth: 1, borderColor: '#222', alignItems: 'center' },
  successTonnageLabel: { color: '#888', fontSize: 12, fontWeight: 'bold', marginBottom: 4, letterSpacing: 0.5 },
  successTonnageValue: { color: THEME.accent, fontSize: 26, fontWeight: '900', marginBottom: 8 },
  successTonnageComparison: { color: '#ccc', fontSize: 14, textAlign: 'center', fontStyle: 'italic', paddingHorizontal: 8 },
  successPrimaryBtn: { backgroundColor: THEME.accent, paddingVertical: 16, paddingHorizontal: 48, borderRadius: 12, marginBottom: 16, minWidth: 200, alignItems: 'center' },
  successPrimaryBtnText: { color: '#000', fontSize: 18, fontWeight: '900' },
  successSecondaryBtn: { paddingVertical: 16, paddingHorizontal: 24, borderRadius: 12, borderWidth: 2, borderColor: THEME.accent, minWidth: 200, alignItems: 'center' },
  successSecondaryBtnText: { color: THEME.accent, fontSize: 16, fontWeight: 'bold' },
  successUndoBtn: { marginTop: 24, paddingVertical: 12, paddingHorizontal: 16 },
  successUndoBtnText: { color: THEME.dim, fontSize: 14 },
  scroll: { padding: 20, paddingBottom: 100 },
  title: { color: '#fff', fontSize: 32, fontWeight: '900', fontStyle: 'italic', marginBottom: 20 },
  progressBarStickyWrap: { backgroundColor: '#000', paddingVertical: 8, paddingHorizontal: 20 },
  progressBarStickyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  progressBarStickyText: { color: '#666', fontSize: 11, fontWeight: '600', minWidth: 72 },
  progressBarTrackSticky: { flex: 1, height: 5 },
  progressBarDivider: { height: 1, backgroundColor: '#222' },
  progressBarTrack: { height: 6, backgroundColor: '#222', borderRadius: 3, overflow: 'hidden' },
  progressBarTrackComplete: { backgroundColor: '#1a2a1a' },
  progressBarFill: { height: '100%', backgroundColor: THEME.accent, borderRadius: 3 },
  progressBarFillComplete: { backgroundColor: THEME.accent, shadowColor: THEME.accent, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 6, elevation: 4 },
  progressBarText: { color: '#666', fontSize: 11, fontWeight: '600', marginTop: 6 },
  progressBarTextComplete: { color: THEME.accent, fontSize: 12, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 15, marginBottom: 20 },
  cycleBtn: { flex: 1, backgroundColor: '#111', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#222' },
  cycleLabel: { color: '#666', fontSize: 10, fontWeight: 'bold' },
  cycleValue: { color: '#CCFF00', fontSize: 24, fontWeight: '900' },
  sourceDate: { color: '#444', fontSize: 12, marginBottom: 20, fontWeight: '600' },
  shoulderCard: { backgroundColor: '#1a1a2e', padding: 14, borderRadius: 12, marginBottom: 14, borderLeftWidth: 4, borderLeftColor: '#f59e0b', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shoulderCardText: { color: '#fff', fontSize: 16, fontWeight: 'bold', flex: 1 },
  shoulderCardDoneBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12 },
  shoulderCardDoneText: { color: THEME.accent, fontSize: 14, fontWeight: 'bold' },
  generateWarmupsBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#222', borderWidth: 1, borderColor: '#333', marginRight: 8 },
  generateWarmupsBtnText: { color: THEME.accent, fontSize: 11, fontWeight: 'bold' },
  exCard: { backgroundColor: '#1E1E1E', paddingHorizontal: 18, paddingVertical: 15, borderRadius: 12, marginBottom: 15, borderLeftWidth: 4, borderLeftColor: '#333' },
  exCardInSuperset: { marginBottom: 0, borderLeftWidth: 0 },
  supersetGroup: { marginBottom: 15, borderLeftWidth: 6, borderLeftColor: THEME.accent, borderRadius: 12, overflow: 'hidden' },
  supersetTag: { color: THEME.accent, fontSize: 10, fontWeight: 'bold', letterSpacing: 1, marginBottom: 6, marginLeft: 15, marginTop: 10 },
  exName: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 5 },
  prevNote: { color: '#CCFF00', fontSize: 13, fontStyle: 'italic', marginBottom: 15, opacity: 0.8 },
  noteInput: { marginTop: 8, backgroundColor: '#242424', color: '#fff', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#333', fontSize: 16, minHeight: 40, textAlignVertical: 'top' },
  setRowContainer: { marginBottom: 15 },
  modifierChip: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: '#222' },
  modifierChipDrop: { backgroundColor: 'rgba(204, 255, 0, 0.2)' },
  modifierChipNegative: { backgroundColor: 'rgba(204, 255, 0, 0.2)' },
  modifierChipText: { color: '#888', fontSize: 12 },
  modifierChipTextActive: { color: THEME.accent },
  specialSetBtn: { backgroundColor: '#222', paddingVertical: 14, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: '#333', flex: 1, justifyContent: 'center', alignItems: 'center' },
  specialSetBtnWrapper: { flex: 1, alignSelf: 'stretch' },
  specialSetBtnDone: { backgroundColor: 'rgba(204, 255, 0, 0.15)', borderWidth: 2, borderColor: THEME.accent },
  specialSetBtnText: { color: '#aaa', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  specialSetBtnTextDone: { color: THEME.accent },
  activeSetRow: { backgroundColor: 'rgba(204, 255, 0, 0.05)', borderRadius: 8, padding: 8 },
  warmupSetRow: { borderLeftWidth: 3, borderLeftColor: '#666', backgroundColor: 'rgba(100, 100, 100, 0.08)', padding: 8, borderRadius: 6 },
  warmupSetLabel: { color: '#888', fontSize: 10 },
  prSetRow: { borderWidth: 2, borderColor: '#FFD700', borderRadius: 8, padding: 8, backgroundColor: 'rgba(255, 215, 0, 0.06)' },
  prBadge: { color: '#FFD700', fontSize: 11, fontWeight: 'bold' },
  setLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  setNumber: { color: '#666', fontSize: 10, fontWeight: 'bold' },
  setNumberActive: { color: THEME.accent },
  lastStats: { color: '#999', fontSize: 11, fontWeight: 'bold' },
  lastStatsOverload: { color: THEME.accent, fontSize: 11, fontWeight: 'bold' },
  inputGroup: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'stretch', gap: 10 },
  lbsInputWrapper: { flex: 1, minWidth: 0, marginRight: 4, position: 'relative' },
  repsInputWrapper: { flex: 1, minWidth: 0, marginLeft: 4 },
  dualInput: { width: '100%', backgroundColor: '#242424', color: '#fff', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, textAlign: 'center', textAlignVertical: 'center', fontWeight: 'bold', borderWidth: 1, borderColor: '#333', fontSize: 16 },
  dualInputFullWidth: { flex: 1 },
  bwBadge: { position: 'absolute', right: 8, top: 10, backgroundColor: '#222', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: '#333' },
  bwBadgeText: { color: '#CCFF00', fontSize: 10, fontWeight: '900' },
  bwBadgeActive: { backgroundColor: '#CCFF00', borderColor: '#CCFF00' },
  bwBadgeTextActive: { color: '#000' },
  finishBtn: { backgroundColor: '#CCFF00', padding: 20, borderRadius: 8, alignItems: 'center', marginVertical: 20 },
  finishText: { fontWeight: '900', fontSize: 18, color: '#000' },
  restTimerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 20, backgroundColor: '#111', borderTopWidth: 1, borderTopColor: THEME.accent, borderLeftWidth: 4, borderLeftColor: THEME.accent, minHeight: 52 },
  restTimerText: { color: THEME.accent, fontSize: 24, fontWeight: '900' },
  restTimerButtons: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  restTimerBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#222', borderWidth: 1, borderColor: '#333' },
  restTimerBtnText: { color: THEME.accent, fontSize: 14, fontWeight: 'bold' },
  restTimerMuteBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  restTimerSkipBtn: { backgroundColor: 'transparent', borderColor: '#555' },
  restTimerSkipBtnText: { color: '#888', fontSize: 14, fontWeight: '600' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#222', backgroundColor: '#000', paddingTop: 8, paddingBottom: 8 },
  stickyBottomWrap: { position: 'absolute', left: 0, right: 0, backgroundColor: '#000', flexDirection: 'column' },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabText: { color: '#666', fontWeight: 'bold' },
  searchBar: { backgroundColor: '#111', color: '#fff', padding: 15, margin: 20, borderRadius: 8, borderWidth: 1, borderColor: '#222', fontWeight: 'bold', fontSize: 16 },
  sessionCard: { backgroundColor: '#111', borderRadius: 12, padding: 15, marginBottom: 20, borderLeftWidth: 4, borderLeftColor: '#CCFF00' },
  sessionHeader: { color: '#CCFF00', fontSize: 12, fontWeight: '900', marginBottom: 10, letterSpacing: 1 },
  logLine: { marginBottom: 8, borderBottomWidth: 1, borderBottomColor: '#222', paddingBottom: 5 },
  logExercise: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  logNotes: { color: '#888', fontSize: 13, lineHeight: 18 },
  chartSection: { marginBottom: 24 },
  chartSectionInner: { paddingHorizontal: 20 },
  chartEdgeToEdge: { marginHorizontal: -20, paddingHorizontal: 16 },
  chartLegendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12 },
  rangePicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rangeBtnActive: { borderColor: THEME.accent, backgroundColor: THEME.accent },
  rangeBtnTextActive: { color: '#000', fontWeight: 'bold' },
  chartWrapper: { marginBottom: 30, backgroundColor: '#111', padding: 18, borderRadius: 16, borderWidth: 1, borderColor: '#1a1a1a' },
  liftPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chartLegend: { flexDirection: 'row', justifyContent: 'center', gap: 20 },
  chartLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chartLegendDot: { width: 10, height: 10, borderRadius: 5 },
  chartLegendText: { color: '#888', fontSize: 12, fontWeight: 'bold' },
  pickerBtn: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: '#333' },
  pickerText: { color: '#666', fontSize: 9, fontWeight: 'bold' },
  noDataText: { color: '#444', textAlign: 'center', marginVertical: 20, fontSize: 11 },
  subBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: '#222', borderWidth: 1, borderColor: '#333' },
  subBtnActive: { backgroundColor: '#333', borderColor: '#CCFF00' },
  subBtnText: { color: '#CCFF00', fontSize: 11, fontWeight: 'bold' },
  editShareRow: { flexDirection: 'row', gap: 12, marginBottom: 0, flexWrap: 'wrap' },
  addRemoveSetRow: { flexDirection: 'row', gap: 12, marginTop: 8, marginBottom: 4 },
  addRemoveSetBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: '#333', backgroundColor: '#1a1a1a' },
  addRemoveSetBtnDisabled: { opacity: 0.4 },
  addRemoveSetText: { color: '#CCFF00', fontSize: 12, fontWeight: 'bold' },
  modalContainer: { flex: 1, backgroundColor: '#000' },
  finishEarlyOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  finishEarlyCard: { backgroundColor: '#111', borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, borderWidth: 1, borderColor: '#222' },
  finishEarlyTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 12, textAlign: 'center' },
  finishEarlyBody: { color: '#aaa', fontSize: 16, lineHeight: 24, marginBottom: 24, textAlign: 'center' },
  finishEarlyActions: { gap: 12 },
  finishEarlyPrimaryBtn: { backgroundColor: THEME.accent, paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  finishEarlyPrimaryBtnText: { color: '#000', fontSize: 17, fontWeight: '900' },
  finishEarlySecondaryBtn: { paddingVertical: 16, borderRadius: 12, alignItems: 'center', borderWidth: 2, borderColor: THEME.accent },
  finishEarlySecondaryBtnText: { color: THEME.accent, fontSize: 16, fontWeight: 'bold' },
  modalHeader: { paddingTop: 24, paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 },
  modalTitle: { color: '#fff', fontSize: 20, fontWeight: '900', flex: 1, minWidth: 0 },
  modalHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalCancelBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  modalCancelBtnText: { color: '#888', fontSize: 16, fontWeight: '600' },
  modalSaveHeaderBtn: { backgroundColor: '#CCFF00', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10 },
  modalSaveHeaderBtnText: { color: '#000', fontSize: 15, fontWeight: '900' },
  modalSubtitle: { color: '#666', fontSize: 12, marginTop: 6 },
  modalScroll: { flex: 1 },
  modalScrollContent: { padding: 20, paddingBottom: 40 },
  modalSectionLabel: { color: '#666', fontSize: 11, fontWeight: 'bold', marginBottom: 10, letterSpacing: 0.5 },
  templateExerciseCard: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#222', marginBottom: 12, padding: 14, overflow: 'hidden' },
  supersetLinkRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 12, marginTop: -4 },
  supersetLinkBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#1a1a1a' },
  supersetLinkBtnActive: { backgroundColor: 'rgba(204, 255, 0, 0.12)' },
  supersetLinkText: { color: '#888', fontSize: 13 },
  supersetLinkTextActive: { color: THEME.accent },
  templateExerciseHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  templateGripRow: { flexDirection: 'row', alignItems: 'center', marginRight: 10, gap: 4 },
  gripIcon: { color: '#555', fontSize: 16, fontWeight: 'bold', letterSpacing: -2 },
  moveBtn: { padding: 6, minWidth: 32, alignItems: 'center' },
  moveBtnText: { color: '#CCFF00', fontSize: 14, fontWeight: 'bold' },
  moveBtnTextDisabled: { color: '#333' },
  templateExerciseName: { color: '#fff', flex: 1, fontSize: 16, fontWeight: '600', minWidth: 0 },
  modalRemoveBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#2a1515', borderWidth: 1, borderColor: '#442' },
  modalRemoveText: { color: '#f66', fontSize: 12, fontWeight: 'bold' },
  templateMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 20, alignItems: 'center' },
  templateSetModifiersRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  templateSetModifierRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  templateSetModifierLabel: { color: '#888', fontSize: 12 },
  setsStepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  setsStepperLabel: { color: '#888', fontSize: 12, fontWeight: '600' },
  stepperBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#222', borderWidth: 1, borderColor: '#333', alignItems: 'center', justifyContent: 'center' },
  stepperBtnText: { color: '#CCFF00', fontSize: 18, fontWeight: 'bold', lineHeight: 20 },
  stepperValue: { color: '#fff', fontSize: 15, fontWeight: 'bold', minWidth: 24, textAlign: 'center' },
  targetRepsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  targetRepsLabel: { color: '#888', fontSize: 12, fontWeight: '600' },
  targetRepsInput: { width: 56, backgroundColor: '#1a1a1a', color: '#fff', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#333', fontSize: 16, fontWeight: '600' },
  modalAddSection: { marginTop: 8 },
  modalAddRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  modalAddInput: { flex: 1, backgroundColor: '#111', color: '#fff', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#222', fontSize: 16 },
  modalAddBtn: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 10, backgroundColor: '#222', borderWidth: 1, borderColor: '#333', justifyContent: 'center' },
  modalAddBtnText: { color: '#CCFF00', fontSize: 14, fontWeight: 'bold' },
  modalFooter: { padding: 20, paddingBottom: 32, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#000' },
  modalSaveBtn: { backgroundColor: '#CCFF00', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  modalSaveBtnText: { color: '#000', fontSize: 17, fontWeight: '900' },
  doneBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#222', borderWidth: 1, borderColor: '#333' },
  doneBtnText: { color: '#CCFF00', fontSize: 13, fontWeight: 'bold' },
});