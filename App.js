import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar, TextInput, Alert, ScrollView, FlatList, ActivityIndicator, Dimensions, Platform, KeyboardAvoidingView } from 'react-native';
import { format } from 'date-fns';
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
  const [substitutions, setSubstitutions] = useState({}); // { originalName: 'Replacement name' } - session only, not saved to template
  const [subbingFor, setSubbingFor] = useState(null); // exercise name we're entering a sub for
  const [subInputValue, setSubInputValue] = useState('');
  const [editMode, setEditMode] = useState(false);
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
          if (editMode) {
            setEditMode(false);
          } else {
            setEditingExercises(currentWorkout.exercises.map(e => ({ ...e, sets: e.sets?.map(s => ({ weight: s.weight ?? '', reps: s.reps ?? '' })) ?? [] })));
            setEditMode(true);
          }
        }}>
          <Text style={styles.subBtnText}>{editMode ? 'Cancel edit' : 'Edit workout'}</Text>
        </TouchableOpacity>

        {editMode ? (
          <View style={styles.exCard}>
            <Text style={styles.exName}>Add/remove exercises (saved to this A/B/C)</Text>
            {editingExercises.map((ex, idx) => (
              <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ color: '#fff', flex: 1 }}>{ex.exercise}</Text>
                <TouchableOpacity style={[styles.subBtn, { backgroundColor: '#522' }]} onPress={() => setEditingExercises(prev => prev.filter((_, i) => i !== idx))}>
                  <Text style={styles.subBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TextInput
                style={[styles.noteInput, { flex: 1, minHeight: 40 }]}
                placeholder="New exercise name"
                placeholderTextColor="#666"
                value={newExerciseName}
                onChangeText={setNewExerciseName}
              />
              <TouchableOpacity style={styles.finishBtn} onPress={() => {
                if (newExerciseName.trim()) {
                  setEditingExercises(prev => [...prev, { exercise: newExerciseName.trim(), note: '', sets: [{ weight: '', reps: '' }, { weight: '', reps: '' }, { weight: '', reps: '' }] }]);
                  setNewExerciseName('');
                }
              }}>
                <Text style={styles.finishText}>+ Add</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={[styles.finishBtn, { marginTop: 8, backgroundColor: '#333' }]} onPress={() => {
              onSaveOverrides?.(todaysType, variation, editingExercises);
              setEditMode(false);
            }}>
              <Text style={styles.finishText}>Save workout</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!editMode && currentWorkout.exercises.map((item, exIdx) => {
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
                  if (subInputValue.trim()) setSubstitutions(s => ({ ...s, [item.exercise]: subInputValue.trim() }));
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
            {item.note ? <Text style={styles.prevNote}>“{item.note}”</Text> : null}
            {item.sets.map((prev, setIdx) => {
              const isMarty = item.exercise === 'Marty St Louis';
              const isBWChecked = inputs[item.exercise]?.sets?.[setIdx]?.weight === 'BW';

              return (
                <View key={`set-row-${exIdx}-${setIdx}`} style={styles.setRowContainer}>
                  <View style={styles.setLabelRow}>
                    <Text style={styles.setNumber}>SET {setIdx + 1}</Text>
                    <Text style={styles.lastStats}>Last: {prev.weight || 'BW'} × {prev.reps}</Text>
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
                      placeholder="Reps" 
                      placeholderTextColor="#444" 
                      keyboardType="number-pad"
                      value={inputs[item.exercise]?.sets?.[setIdx]?.reps || ''}
                      onChangeText={v => updateSetInput(item.exercise, setIdx, 'reps', v)}
                    />
                  </View>
                </View>
              );
            })}
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

// Key lifts to show weight over time (match history exercise names)
const LIFT_KEYWORDS = [
  { key: 'Squat', keywords: ['squat'] },
  { key: 'Bench Press', keywords: ['bench press', 'bench'] },
  { key: 'Incline Bench', keywords: ['incline bench', 'incline press'] },
  { key: 'Curls', keywords: ['curl'] },
  { key: 'Deadlift', keywords: ['deadlift', 'dead lift'] },
];

const ProgressTimeline = ({ history }) => {
  const chartData = useMemo(() => {
    const byLift = {};
    LIFT_KEYWORDS.forEach(({ key }) => { byLift[key] = []; });
    (history || []).forEach((log) => {
      const name = (log.exercise || '').toLowerCase();
      const weight = typeof log.weight === 'number' ? log.weight : getWeight(String(log.notes || ''));
      if (!name) return;
      const match = LIFT_KEYWORDS.find(({ keywords }) => keywords.some(k => name.includes(k)));
      if (!match || weight <= 0) return;
      byLift[match.key].push({ date: log.date, weight });
    });
    const dates = [...new Set((history || []).map(h => h.date))].sort((a, b) => parseWorkoutDate(a) - parseWorkoutDate(b)).slice(-30);
    return dates.map(date => {
      const point = { date };
      LIFT_KEYWORDS.forEach(({ key }) => {
        const entry = byLift[key].find(e => e.date === date);
        point[key] = entry ? entry.weight : null;
      });
      return point;
    }).filter(p => Object.keys(p).some(k => k !== 'date' && p[k] != null));
  }, [history]);

  if (Platform.OS !== 'web' || !chartData.length) {
    return <View style={styles.chartWrapper}><Text style={styles.noDataText}>Weight over time (web)</Text></View>;
  }
  try {
    const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = require('recharts');
    const colors = ['#CCFF00', '#00CCFF', '#FF00CC', '#00FF99', '#FF9900'];
    return (
      <View style={styles.chartWrapper}>
        <Text style={styles.exName}>Weight over time</Text>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="date" stroke="#666" tick={{ fontSize: 10 }} />
            <YAxis stroke="#666" tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333' }} labelStyle={{ color: '#fff' }} />
            {LIFT_KEYWORDS.map(({ key }, i) => (
              <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} dot={{ r: 3 }} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </View>
    );
  } catch (e) {
    return <View style={styles.chartWrapper}><Text style={styles.noDataText}>Chart unavailable</Text></View>;
  }
};

const HistoryScreen = ({ history }) => {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    const filtered = history.filter(h => h.date && (h.exercise?.toLowerCase().includes(search.toLowerCase()) || h.date.includes(search)));
    const map = {};
    filtered.forEach(h => { if (!map[h.date]) map[h.date] = { date: h.date, data: [] }; map[h.date].data.push(h); });
    // Newest first (most recent at top)
    return Object.values(map).sort((a, b) => parseWorkoutDate(b) - parseWorkoutDate(a));
  }, [history, search]);

  return (
    <View style={{ flex: 1 }}>
      <TextInput style={styles.searchBar} placeholder="Search history..." placeholderTextColor="#666" onChangeText={setSearch} />
      <FlatList
        data={sessions}
        keyExtractor={(item, index) => `hist-${index}`}
        renderItem={({ item }) => (
          <View style={styles.sessionCard}>
            <Text style={styles.sessionHeader}>{item.date.toUpperCase()}</Text>
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
  scroll: { padding: 20, paddingBottom: 140 },
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
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#222', backgroundColor: '#000', paddingBottom: 25 },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 15 },
  tabText: { color: '#666', fontWeight: 'bold' },
  searchBar: { backgroundColor: '#111', color: '#fff', padding: 15, margin: 20, borderRadius: 8, borderWidth: 1, borderColor: '#222', fontWeight: 'bold' },
  sessionCard: { backgroundColor: '#111', borderRadius: 12, padding: 15, marginBottom: 20, borderLeftWidth: 4, borderLeftColor: '#CCFF00' },
  sessionHeader: { color: '#CCFF00', fontSize: 12, fontWeight: '900', marginBottom: 10, letterSpacing: 1 },
  logLine: { marginBottom: 8, borderBottomWidth: 1, borderBottomColor: '#222', paddingBottom: 5 },
  logExercise: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  logNotes: { color: '#888', fontSize: 13, lineHeight: 18 },
  chartWrapper: { marginBottom: 30, backgroundColor: '#111', padding: 15, borderRadius: 16 },
  liftPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  pickerBtn: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: '#333' },
  pickerText: { color: '#666', fontSize: 9, fontWeight: 'bold' },
  noDataText: { color: '#444', textAlign: 'center', marginVertical: 20, fontSize: 11 },
  subBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: '#222', borderWidth: 1, borderColor: '#333' },
  subBtnActive: { backgroundColor: '#333', borderColor: '#CCFF00' },
  subBtnText: { color: '#CCFF00', fontSize: 11, fontWeight: 'bold' },
});