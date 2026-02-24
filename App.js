import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar, TextInput, Alert, ScrollView, FlatList, ActivityIndicator, Dimensions, Platform, KeyboardAvoidingView, Keyboard } from 'react-native';
import { format } from 'date-fns';
import AsyncStorage from '@react-native-async-storage/async-storage';
import seedData from './seed_data.json'; 

const SCREEN_WIDTH = Dimensions.get('window').width;
const THEME = { bg: '#000', card: '#111', text: '#fff', accent: '#CCFF00', highlight: '#222', dim: '#444' };
const TOOLBAR_ID = "workout_nav_bar_2026"; // Hardcoded stable ID

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
const TodayScreen = ({ history, onFinish }) => {
  const [todaysType, setTodaysType] = useState('Push');
  const [variation, setVariation] = useState('A');
  const [inputs, setInputs] = useState({});
  const [activeInputId, setActiveInputId] = useState(null);
  const inputRefs = useRef({});

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Keyboard.addListener('keyboardDidHide', () => setActiveInputId(null));
    return () => sub.remove();
  }, []);

  const showBWButton = (name) => {
    const bwKeywords = ['squat', 'push up', 'pull up', 'chin up', 'dip', 'abs', 'leg raise', 'crunch', 'sit up', 'hanging', 'plank'];
    return bwKeywords.some(k => name.toLowerCase().includes(k));
  };

  const currentWorkout = useMemo(() => {
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
  }, [todaysType, variation]);

  const inputOrder = useMemo(() => {
    const order = [];
    currentWorkout.exercises.forEach((ex, exIdx) => {
      ex.sets.forEach((_, setIdx) => {
        const isMarty = ex.exercise === 'Marty St Louis';
        if (!isMarty) {
          order.push(`ref-${exIdx}-${setIdx}-w`);
        }
        order.push(`ref-${exIdx}-${setIdx}-r`);
      });
      // Add note field as last stop for this exercise
      order.push(`ref-${exIdx}-note`);
    });
    return order;
  }, [currentWorkout]);

  const navigateKeyboard = (direction) => {
    const currentIndex = inputOrder.indexOf(activeInputId);
    const nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex >= 0 && nextIndex < inputOrder.length) {
      const nextId = inputOrder[nextIndex];
      inputRefs.current[nextId]?.focus?.();
    } else {
      Keyboard.dismiss();
    }
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

  const save = (abs) => {
    const logs = Object.keys(inputs).map(name => {
      const ex = inputs[name] || {};
      const setArray = Object.keys(ex.sets || {}).sort().map(idx => {
        const s = ex.sets[idx];
        return `${s.weight || 0}x${s.reps || 0}`;
      });
      return {
        date: format(new Date(), 'MM/dd/yy'),
        exercise: name,
        notes: setArray.join(', ') + (ex.cues ? ` | ${ex.cues}` : "") + (abs ? " (Abs Done)" : ""),
        weight: ex.sets?.['0']?.weight === 'BW' ? 0 : getWeight(setArray[0] || ""),
        type: currentWorkout.type
      };
    });
    onFinish(logs);
    setInputs({});
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

        {currentWorkout.exercises.map((item, exIdx) => (
          <View key={`ex-card-${exIdx}`} style={styles.exCard}>
            <Text style={styles.exName}>{item.exercise}</Text>
            {item.note ? <Text style={styles.prevNote}>“{item.note}”</Text> : null}
            {item.sets.map((prev, setIdx) => {
              const weightId = `ref-${exIdx}-${setIdx}-w`;
              const repsId = `ref-${exIdx}-${setIdx}-r`;
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
                          ref={r => { if (r) inputRefs.current[weightId] = r; }}
                          style={styles.dualInput} 
                          placeholder="Lbs" 
                          placeholderTextColor="#444" 
                          keyboardType="number-pad"
                          onFocus={() => setActiveInputId(weightId)}
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
                      ref={r => { if (r) inputRefs.current[repsId] = r; }}
                      style={[styles.dualInput, isMarty && { flex: 1 }]} 
                      placeholder="Reps" 
                      placeholderTextColor="#444" 
                      keyboardType="number-pad"
                      onFocus={() => setActiveInputId(repsId)}
                      value={inputs[item.exercise]?.sets?.[setIdx]?.reps || ''}
                      onChangeText={v => updateSetInput(item.exercise, setIdx, 'reps', v)}
                    />
                  </View>
                </View>
              );
            })}
            {/* Notes input for this exercise */}
            <TextInput
              ref={r => {
                if (r) inputRefs.current[`ref-${exIdx}-note`] = r;
              }}
              style={styles.noteInput}
              placeholder="Add notes for this exercise..."
              placeholderTextColor="#666"
              keyboardType="default"
              returnKeyType="done"
              multiline
              onFocus={() => setActiveInputId(`ref-${exIdx}-note`)}
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
        ))}
        <TouchableOpacity style={styles.finishBtn} onPress={() => save(false)}>
          <Text style={styles.finishText}>FINISH ✓</Text>
        </TouchableOpacity>
      </ScrollView>

      {!!activeInputId && (
        <View style={styles.keyboardToolbarContainer}>
          <View style={styles.keyboardToolbar}>
            <View style={styles.navGroup}>
              <TouchableOpacity onPress={() => navigateKeyboard('prev')} style={styles.navBtn}>
                <Text style={styles.navBtnText}>▲</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => navigateKeyboard('next')} style={styles.navBtn}>
                <Text style={styles.navBtnText}>▼</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => Keyboard.dismiss()} style={styles.doneBtn}>
              <Text style={styles.doneBtnText}>DONE</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

// Placeholder so Archive tab works (chart can be added later, native-only)
const ProgressTimeline = () => null;

const HistoryScreen = ({ history }) => {
  const [search, setSearch] = useState('');
  const sessions = useMemo(() => {
    const filtered = history.filter(h => h.date && (h.exercise?.toLowerCase().includes(search.toLowerCase()) || h.date.includes(search)));
    const map = {};
    filtered.forEach(h => { if (!map[h.date]) map[h.date] = { date: h.date, data: [] }; map[h.date].data.push(h); });
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

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const stored = await AsyncStorage.getItem('workout_history');
      const parsedStored = stored ? JSON.parse(stored) : [];
      setHistory([...seedData, ...parsedStored]);
    } catch (e) { setHistory(seedData); } finally { setLoading(false); }
  };

  const onFinish = async (logs) => {
    const updated = [...history, ...logs];
    setHistory(updated);
    await AsyncStorage.setItem('workout_history', JSON.stringify(updated));
  };

  if (loading) return <View style={[styles.container, {justifyContent:'center'}]}><ActivityIndicator size="large" color="#CCFF00" /></View>;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <View style={{flex:1}}>{tab === 'Today' ? <TodayScreen history={history} onFinish={onFinish} /> : <HistoryScreen history={history} />}</View>
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
  keyboardToolbarContainer: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 999, elevation: 20 },
  keyboardToolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: 1, borderColor: '#333' },
  navGroup: { flexDirection: 'row', gap: 20 },
  navBtn: { padding: 5 },
  navBtnText: { color: '#CCFF00', fontSize: 20, fontWeight: 'bold' },
  doneBtn: { backgroundColor: '#333', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 6 },
  doneBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 12 }
  // No custom keyboard toolbar styles
});