import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar, TextInput, Alert, ScrollView, FlatList, ActivityIndicator, Dimensions, Platform, KeyboardAvoidingView, Modal, Pressable } from 'react-native';
import { format, startOfMonth, startOfYear, addMonths, addYears } from 'date-fns';
import AsyncStorage from '@react-native-async-storage/async-storage';
import seedData from './seed_data.json'; 

const SCREEN_WIDTH = Dimensions.get('window').width;
const THEME = { bg: '#000', card: '#111', text: '#fff', accent: '#CCFF00', highlight: '#222', dim: '#444' };

// Order: Push A → Pull A → Legs A → Push B → Pull B → Legs B → Push C → Pull C → Legs KOT
const WORKOUT_SEQUENCE = [
  { type: 'Push', variation: 'A' }, { type: 'Pull', variation: 'A' }, { type: 'Legs', variation: 'A' },
  { type: 'Push', variation: 'B' }, { type: 'Pull', variation: 'B' }, { type: 'Legs', variation: 'B' },
  { type: 'Push', variation: 'C' }, { type: 'Pull', variation: 'C' }, { type: 'Legs', variation: 'KOT' },
];
const LAST_WORKOUT_KEY = 'workout_tracker_last_completed';
const OVERRIDES_KEY = 'workout_tracker_overrides';

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
 */
const getDistinctSessionDates = (data, typeKey, count) => {
  const filtered = data.filter(
    (d) => d.type && d.type.toLowerCase().includes(typeKey.toLowerCase())
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
  return result;
};

// --- TODAY SCREEN COMPONENT ---
const TodayScreen = ({ history, onFinish, initialType, initialVariation, overrides, onSaveOverrides }) => {
  const [todaysType, setTodaysType] = useState(initialType || 'Push');
  const [variation, setVariation] = useState(initialVariation || 'A');
  const [inputs, setInputs] = useState({});
  const [substitutions, setSubstitutions] = useState({}); // { originalName: 'Replacement name' } - session only
  const [subSetCount, setSubSetCount] = useState({}); // { originalName: number } - sets count when subbed (today only)
  const [subbingFor, setSubbingFor] = useState(null);
  const [subInputValue, setSubInputValue] = useState('');
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingExercises, setEditingExercises] = useState([]);
  const [newExerciseName, setNewExerciseName] = useState('');

  useEffect(() => {
    if (initialType) setTodaysType(initialType);
    if (initialVariation) setVariation(initialVariation);
  }, [initialType, initialVariation]);

  const showBWButton = (name) => {
    const bwKeywords = ['squat', 'push up', 'pull up', 'chin up', 'dip', 'abs', 'leg raise', 'crunch', 'sit up', 'hanging', 'plank'];
    return bwKeywords.some(k => name.toLowerCase().includes(k));
  };

  const currentWorkout = useMemo(() => {
    const overrideExercises = overrides?.[todaysType]?.[variation]?.exercises;
    if (overrideExercises?.length) {
      return {
        type: todaysType === 'Legs' ? 'Heavy Legs and Shoulders' : todaysType,
        date: 'Custom',
        exercises: overrideExercises,
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
            { weight: '', reps: '' },
            { weight: '', reps: '' },
            { weight: '', reps: '' },
          ],
        };

        return {
          type: 'KOT',
          date: targetDate,
          // Marty first, then the rest (no duplicate)
          exercises: [martyExercise, ...otherExercises],
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
        exercises: heavySessions.filter((d) => d.date === targetDate),
      };
    }

    // Push / Pull: three most recent *distinct* templates (different exercises)
    const searchKey = todaysType;
    const distinctDates = getDistinctSessionDates(seedData, searchKey, 3);
    const targetIdx =
      variation === 'A' ? 0 : variation === 'B' ? 1 : 2;
    const targetDate = distinctDates[targetIdx] ?? distinctDates[0];
    const filtered = seedData.filter(
      (d) =>
        d.type &&
        d.type.toLowerCase().includes(searchKey.toLowerCase()) &&
        d.date === targetDate
    );
    return {
      type: filtered[0]?.type || searchKey,
      date: targetDate,
      exercises: filtered,
    };
  }, [todaysType, variation, overrides]);

  const updateSetInput = (exerciseName, setIndex, field, value) => {
    setInputs(prev => ({
      ...prev,
      [exerciseName]: {
        ...prev[exerciseName],
        sets: { ...prev[exerciseName]?.sets, [setIndex]: { ...prev[exerciseName]?.sets?.[setIndex], [field]: value } }
      }
    }));
  };

  const save = (abs) => {
    const logs = Object.keys(inputs).map(name => {
      const ex = inputs[name] || {};
      const setArray = Object.keys(ex.sets || {}).sort().map(idx => {
        const s = ex.sets[idx];
        return `${s.weight || 0}x${s.reps || 0}`;
      });
      const loggedName = substitutions[name] ?? name;
      return {
        date: format(new Date(), 'MM/dd/yy'),
        exercise: loggedName,
        notes: setArray.join(', ') + (ex.cues ? ` | ${ex.cues}` : "") + (abs ? " (Abs Done)" : ""),
        weight: ex.sets?.['0']?.weight === 'BW' ? 0 : getWeight(setArray[0] || ""),
        type: currentWorkout.type
      };
    });
    onFinish(logs, { type: todaysType, variation });
    setInputs({});
    setSubstitutions({});
    setSubSetCount({});
    Alert.alert("Success", "2026 Log Saved.");
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView 
        contentContainerStyle={styles.scroll} 
        keyboardShouldPersistTaps="always"
        removeClippedSubviews={false} // Prevents iOS from "unmounting" middle inputs
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

        <TouchableOpacity style={[styles.subBtn, { alignSelf: 'flex-start', marginBottom: 12 }]} onPress={() => {
          setEditingExercises(currentWorkout.exercises.map(e => {
            const sets = e.sets?.map(s => ({ weight: s.weight ?? '', reps: String(s.reps ?? '').trim() || '' })) ?? [{ weight: '', reps: '' }];
            return { ...e, sets, targetReps: e.targetReps ?? '' };
          }));
          setNewExerciseName('');
          setEditModalVisible(true);
        }}>
          <Text style={styles.subBtnText}>Edit workout</Text>
        </TouchableOpacity>

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
                <View key={`ex-${idx}-${ex.exercise}`} style={styles.templateExerciseCard}>
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
                      <TouchableOpacity style={styles.stepperBtn} onPress={() => setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, sets: [...e.sets, { weight: '', reps: e.targetReps || '' }] } : e))}>
                        <Text style={styles.stepperBtnText}>+</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.targetRepsRow}>
                      <Text style={styles.targetRepsLabel}>Target reps</Text>
                      <TextInput
                        style={styles.targetRepsInput}
                        placeholder="e.g. 8"
                        placeholderTextColor="#555"
                        value={ex.targetReps}
                        onChangeText={(v) => setEditingExercises(prev => prev.map((e, i) => i === idx ? { ...e, targetReps: v } : e))}
                        keyboardType="number-pad"
                      />
                    </View>
                  </View>
                </View>
              ))}
              <View style={styles.modalAddSection}>
                <Text style={styles.modalSectionLabel}>Add exercise</Text>
                <View style={styles.modalAddRow}>
                  <TextInput
                    style={styles.modalAddInput}
                    placeholder="New exercise name"
                    placeholderTextColor="#666"
                    value={newExerciseName}
                    onChangeText={setNewExerciseName}
                  />
                  <TouchableOpacity style={styles.modalAddBtn} onPress={() => {
                    if (newExerciseName.trim()) {
                      setEditingExercises(prev => [...prev, { exercise: newExerciseName.trim(), note: '', targetReps: '', sets: [{ weight: '', reps: '' }, { weight: '', reps: '' }, { weight: '', reps: '' }] }]);
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

        {currentWorkout.exercises.map((item, exIdx) => {
          const displayName = substitutions[item.exercise] ?? item.exercise;
          const isSubbed = !!substitutions[item.exercise];
          return (
          <View key={`ex-card-${exIdx}`} style={styles.exCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[styles.exName, { flex: 1 }]} numberOfLines={2}>{displayName}{isSubbed ? ` (sub: ${item.exercise})` : ''}</Text>
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
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                <TextInput
                  style={[styles.noteInput, { flex: 1, minHeight: 36 }]}
                  placeholder="Replacement (today only)"
                  placeholderTextColor="#666"
                  value={subInputValue}
                  onChangeText={setSubInputValue}
                />
                <TouchableOpacity style={styles.doneBtn} onPress={() => {
                  if (subInputValue.trim()) {
                    setSubstitutions(s => ({ ...s, [item.exercise]: subInputValue.trim() }));
                    setSubSetCount(c => ({ ...c, [item.exercise]: 1 }));
                    setInputs(prev => ({ ...prev, [item.exercise]: { sets: { 0: { weight: '', reps: '' } }, cues: prev[item.exercise]?.cues ?? '' } }));
                  }
                  setSubbingFor(null);
                  setSubInputValue('');
                }}>
                  <Text style={styles.doneBtnText}>Apply</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.doneBtn} onPress={() => { setSubbingFor(null); setSubInputValue(''); }}>
                  <Text style={styles.doneBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}
            {item.note && !isSubbed ? <Text style={styles.prevNote}>“{item.note}”</Text> : null}
            {(isSubbed ? Array.from({ length: subSetCount[item.exercise] ?? 1 }, (_, i) => i) : item.sets.map((_, i) => i)).map((setIdx) => {
              const isMarty = item.exercise === 'Marty St Louis';
              const isBWChecked = inputs[item.exercise]?.sets?.[setIdx]?.weight === 'BW';
              const prevSet = !isSubbed && item.sets[setIdx] ? item.sets[setIdx] : null;

              return (
                <View key={`set-row-${exIdx}-${setIdx}`} style={styles.setRowContainer}>
                  <View style={styles.setLabelRow}>
                    <Text style={styles.setNumber}>SET {setIdx + 1}</Text>
                    <Text style={styles.lastStats}>{prevSet ? `Last: ${prevSet.weight || 'BW'} × ${prevSet.reps}` : '—'}</Text>
                  </View>
                  <View style={styles.inputGroup}>
                    {!isMarty && (
                      <View style={{ flex: 1, position: 'relative' }}>
                        <TextInput 
                          style={styles.dualInput} 
                          placeholder="Lbs" 
                          placeholderTextColor="#444" 
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
                    <TextInput 
                      style={[styles.dualInput, isMarty && { flex: 1 }]} 
                      placeholder={item.targetReps ? `Reps (${item.targetReps})` : 'Reps'} 
                      placeholderTextColor="#444" 
                      keyboardType="number-pad"
                      value={inputs[item.exercise]?.sets?.[setIdx]?.reps || ''}
                      onChangeText={v => updateSetInput(item.exercise, setIdx, 'reps', v)}
                    />
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
              placeholderTextColor="#666"
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
        <TouchableOpacity style={styles.finishBtn} onPress={() => save(false)}>
          <Text style={styles.finishText}>FINISH ✓</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

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

const HistoryScreen = ({ history }) => {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    const filtered = history.filter(h => h.date && searchMatchesLog(search, h));
    const map = {};
    filtered.forEach(h => { if (!map[h.date]) map[h.date] = { date: h.date, data: [] }; map[h.date].data.push(h); });
    const list = Object.values(map);
    list.sort((a, b) => parseWorkoutDate(b.date) - parseWorkoutDate(a.date));
    return list;
  }, [history, search]);

  return (
    <View style={{ flex: 1 }}>
      <TextInput style={styles.searchBar} placeholder="Search history..." placeholderTextColor="#666" onChangeText={setSearch} />
      <FlatList
        data={sessions}
        keyExtractor={(item, index) => `hist-${index}`}
        renderItem={({ item }) => (
          <View style={styles.sessionCard}>
            <Text style={styles.sessionHeader}>{item.date.toUpperCase()}{item.data?.[0]?.type ? ` · ${item.data[0].type.toUpperCase()}` : ''}</Text>
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

export default function App() {
  const [tab, setTab] = useState('Today');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [suggestedWorkout, setSuggestedWorkout] = useState(null);
  const [overrides, setOverrides] = useState({});

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [stored, overridesStored] = await Promise.all([
        AsyncStorage.getItem('workout_history'),
        AsyncStorage.getItem(OVERRIDES_KEY),
      ]);
      const parsedStored = stored ? JSON.parse(stored) : [];
      setHistory([...seedData, ...parsedStored]);
      setOverrides(overridesStored ? JSON.parse(overridesStored) : {});
    } catch (e) {
      setHistory(seedData);
      setOverrides({});
    } finally { setLoading(false); }
  };

  const onSaveOverrides = async (type, variation, exercises) => {
    const next = {
      ...overrides,
      [type]: { ...overrides[type], [variation]: { exercises } },
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

  const onFinish = async (logs, completed) => {
    const updated = [...history, ...logs];
    setHistory(updated);
    await AsyncStorage.setItem('workout_history', JSON.stringify(updated));
    if (completed) {
      await AsyncStorage.setItem(LAST_WORKOUT_KEY, JSON.stringify(completed));
      const idx = WORKOUT_SEQUENCE.findIndex(w => w.type === completed.type && w.variation === completed.variation);
      const nextIdx = (idx + 1) % WORKOUT_SEQUENCE.length;
      setSuggestedWorkout(WORKOUT_SEQUENCE[nextIdx]);
    }
  };

  if (loading) return <View style={[styles.container, {justifyContent:'center'}]}><ActivityIndicator size="large" color="#CCFF00" /></View>;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <View style={{flex:1}}>{tab === 'Today' ? <TodayScreen history={history} onFinish={onFinish} initialType={suggestedWorkout?.type} initialVariation={suggestedWorkout?.variation} overrides={overrides} onSaveOverrides={onSaveOverrides} /> : <HistoryScreen history={history} />}</View>
        <View style={styles.tabBar}>
          <TouchableOpacity onPress={() => setTab('Today')} style={styles.tabItem}><Text style={[styles.tabText, tab==='Today' && {color: THEME.accent}]}>TODAY</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setTab('Stats')} style={styles.tabItem}><Text style={[styles.tabText, tab==='Stats' && {color: THEME.accent}]}>ARCHIVE</Text></TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  scroll: { padding: 20, paddingBottom: 100 },
  title: { color: '#fff', fontSize: 32, fontWeight: '900', fontStyle: 'italic', marginBottom: 20 },
  row: { flexDirection: 'row', gap: 15, marginBottom: 20 },
  cycleBtn: { flex: 1, backgroundColor: '#111', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#222' },
  cycleLabel: { color: '#666', fontSize: 10, fontWeight: 'bold' },
  cycleValue: { color: '#CCFF00', fontSize: 24, fontWeight: '900' },
  sourceDate: { color: '#444', fontSize: 12, marginBottom: 20, fontWeight: '600' },
  exCard: { backgroundColor: '#0a0a0a', padding: 15, borderRadius: 12, marginBottom: 15, borderLeftWidth: 4, borderLeftColor: '#333' },
  exName: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 5 },
  prevNote: { color: '#CCFF00', fontSize: 13, fontStyle: 'italic', marginBottom: 15, opacity: 0.8 },
  noteInput: { marginTop: 8, backgroundColor: '#111', color: '#fff', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#222', fontSize: 13, minHeight: 40, textAlignVertical: 'top' },
  setRowContainer: { marginBottom: 15 },
  setLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  setNumber: { color: '#666', fontSize: 10, fontWeight: 'bold' },
  lastStats: { color: '#444', fontSize: 10, fontWeight: 'bold' },
  inputGroup: { flexDirection: 'row', gap: 10 },
  dualInput: { flex: 1, backgroundColor: '#1A1A1A', color: '#fff', padding: 12, borderRadius: 8, textAlign: 'center', fontWeight: 'bold', borderWidth: 1, borderColor: '#222' },
  bwBadge: { position: 'absolute', right: 8, top: 10, backgroundColor: '#222', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: '#333' },
  bwBadgeText: { color: '#CCFF00', fontSize: 10, fontWeight: '900' },
  bwBadgeActive: { backgroundColor: '#CCFF00', borderColor: '#CCFF00' },
  bwBadgeTextActive: { color: '#000' },
  finishBtn: { backgroundColor: '#CCFF00', padding: 20, borderRadius: 8, alignItems: 'center', marginVertical: 20 },
  finishText: { fontWeight: '900', fontSize: 18, color: '#000' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#222', backgroundColor: '#000', paddingTop: 8, paddingBottom: 8 },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabText: { color: '#666', fontWeight: 'bold' },
  searchBar: { backgroundColor: '#111', color: '#fff', padding: 15, margin: 20, borderRadius: 8, borderWidth: 1, borderColor: '#222', fontWeight: 'bold' },
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
  addRemoveSetRow: { flexDirection: 'row', gap: 12, marginTop: 8, marginBottom: 4 },
  addRemoveSetBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: '#333', backgroundColor: '#1a1a1a' },
  addRemoveSetBtnDisabled: { opacity: 0.4 },
  addRemoveSetText: { color: '#CCFF00', fontSize: 12, fontWeight: 'bold' },
  modalContainer: { flex: 1, backgroundColor: '#000' },
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
  setsStepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  setsStepperLabel: { color: '#888', fontSize: 12, fontWeight: '600' },
  stepperBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#222', borderWidth: 1, borderColor: '#333', alignItems: 'center', justifyContent: 'center' },
  stepperBtnText: { color: '#CCFF00', fontSize: 18, fontWeight: 'bold', lineHeight: 20 },
  stepperValue: { color: '#fff', fontSize: 15, fontWeight: 'bold', minWidth: 24, textAlign: 'center' },
  targetRepsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  targetRepsLabel: { color: '#888', fontSize: 12, fontWeight: '600' },
  targetRepsInput: { width: 56, backgroundColor: '#1a1a1a', color: '#fff', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#333', fontSize: 14, fontWeight: '600' },
  modalAddSection: { marginTop: 8 },
  modalAddRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  modalAddInput: { flex: 1, backgroundColor: '#111', color: '#fff', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#222', fontSize: 15 },
  modalAddBtn: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 10, backgroundColor: '#222', borderWidth: 1, borderColor: '#333', justifyContent: 'center' },
  modalAddBtnText: { color: '#CCFF00', fontSize: 14, fontWeight: 'bold' },
  modalFooter: { padding: 20, paddingBottom: 32, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#000' },
  modalSaveBtn: { backgroundColor: '#CCFF00', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  modalSaveBtnText: { color: '#000', fontSize: 17, fontWeight: '900' },
  doneBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#222', borderWidth: 1, borderColor: '#333' },
  doneBtnText: { color: '#CCFF00', fontSize: 13, fontWeight: 'bold' },
});