import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Text } from '../../src/components/AppText';
import { useLanguage } from '../../src/state/LanguageContext';
import { APP_FEE, coordinationFee } from '../../src/data';
import { Card, Num, PrimaryButton, Screen, SectionLabel, Title } from '../../src/components/UI';
import { colors, fmt } from '../../src/theme';

const EXAMPLE_FARES = [20, 50]; // Illustrative per-Travel fares, never a quote or earnings forecast.
const WEEKS_PER_YEAR = 52;

export default function OperatorEconomics() {
  const { t } = useLanguage();
  const router = useRouter();
  const [weeklyFare, setWeeklyFare] = useState('');
  const [showAccountTerms, setShowAccountTerms] = useState(false);
  const raw = weeklyFare.trim().replace(',', '.');
  const valid = /^\d+(?:\.\d{0,2})?$/.test(raw) && Number(raw) > 0 && Number(raw) <= 1000000;
  const fare = valid ? Math.round(Number(raw) * 100) / 100 : null;
  const retained = fare == null ? null : fare - coordinationFee(fare);
  return (
    <Screen>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backText}>{t('common.back')}</Text>
      </Pressable>
      <Title>{t('operator.econTitle')}</Title>
      <Text style={styles.lead}>{t('operator.econIntro')}</Text>
      <Card style={styles.ruleCard}>
        <Num size={46} weight="600" style={styles.heroPercent}>99%</Num>
        <Text style={styles.rule}>{t('operator.econShare')}</Text>
        <Text style={styles.detail}>{t('operator.econFee')}</Text>
      </Card>
      <Card style={styles.platformCard}>
        <Text style={styles.platformHeading}>{t('operator.econPlatformFeeTitle', { amount: fmt(APP_FEE) })}</Text>
        <Text style={styles.detail}>{t('operator.econPlatformFeeDetail')}</Text>
      </Card>
      <SectionLabel style={styles.section}>{t('operator.econExamples')}</SectionLabel>
      {EXAMPLE_FARES.map((example) => {
        const commission = coordinationFee(example);
        return (
          <Card key={example} style={styles.example}>
            <Text style={styles.exampleTitle}>{t('operator.econExampleFare', { amount: fmt(example) })}</Text>
            <View style={styles.row}>
              <Text style={styles.detail}>{t('operator.econOperatorRetains')}</Text>
              <Text style={styles.amount}>{fmt(example - commission)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.detail}>{t('operator.econAmericanRiderShare')}</Text>
              <Text style={styles.amount}>{fmt(commission)}</Text>
            </View>
          </Card>
        );
      })}
      <SectionLabel style={styles.section}>{t('operator.econYourScenario')}</SectionLabel>
      <Card style={styles.example}>
        <Text style={styles.detail}>{t('operator.econWeeklyInput')}</Text>
        <TextInput
          value={weeklyFare}
          onChangeText={setWeeklyFare}
          keyboardType="decimal-pad"
          maxLength={10}
          placeholder={t('operator.econAmountPlaceholder')}
          placeholderTextColor={colors.faint}
          accessibilityLabel={t('operator.econWeeklyInput')}
          style={styles.input}
        />
        {weeklyFare.length > 0 && !valid && (
          <Text accessibilityRole="alert" style={styles.error}>{t('operator.econInvalid')}</Text>
        )}
        {retained != null && (
          <>
            <Text style={styles.illustrationTitle}>{t('operator.econRetainedIllustration')}</Text>
            <View style={styles.row}><Text style={styles.detail}>{t('operator.econWeek')}</Text><Text style={styles.amount}>{fmt(retained)}</Text></View>
            <View style={styles.row}><Text style={styles.detail}>{t('operator.econMonth')}</Text><Text style={styles.amount}>{fmt(retained * WEEKS_PER_YEAR / 12)}</Text></View>
            <View style={styles.row}><Text style={styles.detail}>{t('operator.econYear')}</Text><Text style={styles.amount}>{fmt(retained * WEEKS_PER_YEAR)}</Text></View>
            <Text style={styles.estimateNote}>{t('operator.econProjectionNote')}</Text>
          </>
        )}
      </Card>
      <SectionLabel style={styles.section}>{t('operator.econCostsHeading')}</SectionLabel>
      <Card style={styles.example}>
        <Text style={styles.detail}>{t('operator.econAccountCostNote')}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showAccountTerms }}
          onPress={() => setShowAccountTerms((previous) => !previous)}
          style={styles.termsToggle}
        >
          <Text style={styles.termsToggleText}>
            {t(showAccountTerms ? 'operator.econHideAccountTerms' : 'operator.econShowAccountTerms')}
          </Text>
        </Pressable>
        {showAccountTerms && <Text style={styles.detail}>{t('operator.activeAccountCostBody')}</Text>}
      </Card>
      <Text style={styles.disclaimer}>{t('operator.econDisclaimer')}</Text>
      <Pressable accessibilityRole="button" onPress={() => router.navigate('/operator/market-research')} style={styles.researchLink}>
        <Text style={styles.researchLinkText}>{t('operator.fareResearchLink')} ›</Text>
      </Pressable>
      <PrimaryButton
        label={t('operator.econReviewRequirements')}
        onPress={() => router.replace('/operator/qualify')}
        style={{ marginTop: 24 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { color: colors.ink, fontSize: 15 },
  lead: { color: colors.ink2, fontSize: 15, lineHeight: 23, marginTop: 12 },
  ruleCard: { marginTop: 22, padding: 20 },
  platformCard: { marginTop: 12, padding: 18 },
  platformHeading: { color: colors.ink, fontSize: 16, fontWeight: '600', lineHeight: 23, marginBottom: 6 },
  heroPercent: { letterSpacing: -1.5, marginBottom: 4 },
  rule: { color: colors.ink, fontSize: 17, fontWeight: '600', lineHeight: 24, marginBottom: 9 },
  detail: { color: colors.ink2, fontSize: 14, lineHeight: 21, flexShrink: 1 },
  section: { marginTop: 26 },
  example: { marginTop: 10, padding: 18 },
  exampleTitle: { fontSize: 15, fontWeight: '600', color: colors.ink, marginBottom: 10 },
  illustrationTitle: { fontSize: 14, fontWeight: '600', color: colors.ink, marginTop: 20, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
  amount: { fontSize: 15, fontWeight: '600', color: colors.ink, textAlign: 'right' },
  input: { minHeight: 48, marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  error: { color: colors.red, marginTop: 8, fontSize: 13 },
  estimateNote: { color: colors.ink2, marginTop: 12, fontSize: 13, lineHeight: 19 },
  termsToggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 6 },
  termsToggleText: { color: colors.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  researchLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 10 },
  researchLinkText: { color: colors.ink2, fontSize: 14, textDecorationLine: 'underline' },
  disclaimer: { color: colors.ink2, fontSize: 13, lineHeight: 19, marginTop: 16 },
});
