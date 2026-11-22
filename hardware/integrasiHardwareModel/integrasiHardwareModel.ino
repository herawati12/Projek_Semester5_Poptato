/*
  POPTATO FINAL - ESP32 + ResNet50 (FastAPI) + HX711 + 5 servo + L298N

  Sequence: dashboard /predict -> CNN GOOD/BAD command -> ESP32 waits for
  stable weight -> claims command ONCE -> servo 1 -> conveyor ->
  GOOD: servo 2/3/4/5 by weight; BAD: exit reject bin (no sort servo) ->
  confirm completion -> next potato.

  Requires libraries: ESP32Servo, HX711 (bogde), ArduinoJson v7.
  WARNING: test without mechanical loads first. Supply servos from
  dedicated 5V regulator, motor from rated source via L298N; COMMON GND.
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include "HX711.h"

// === EDIT THESE ===
const char* WIFI_SSID = "DR.OD New";
const char* WIFI_PASSWORD = "987456321";
const char* API_ROOT = "http://192.168.1.8:8000";

#define HX_DOUT 32
#define HX_SCK 33
#define IN1 25
#define IN2 26
#define ENA 27

const int SERVO_PINS[5] = {18, 19, 21, 22, 23};
Servo servos[5];
HX711 scale;

const float CALIBRATION_FACTOR = -1202.298706f; // provisional
const float MIN_WEIGHT_G = 5.0f;
const float STABILITY_SPREAD_G = 3.0f;

const int REST_ANGLE = 90;
const int PUSH_ANGLE = 130;
const int SORT_ANGLE = 130;
const int SERVO_STEP_MS = 30;
const unsigned long TIME_TO_SERVO_MS[4] = {1000, 2000, 3000, 4000};
const unsigned long TIME_TO_REJECT_MS = 6500; // MEASURE actual travel to end
const unsigned long CONVEYOR_EXTRA_MS = 1000;

String lastExecutedId = "";
bool waitingForEmpty = false;
unsigned long lastPollMs = 0;
const unsigned long POLL_MS = 1000;

void motorStop() {
  digitalWrite(ENA, LOW);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
}

void motorForward() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  digitalWrite(ENA, HIGH);
}

void moveSlow(int index, int fromAngle, int toAngle) {
  int direction = fromAngle <= toAngle ? 1 : -1;
  for (int angle = fromAngle; angle != toAngle; angle += direction) {
    servos[index].write(angle);
    delay(SERVO_STEP_MS);
  }
  servos[index].write(toAngle);
}

bool readStableWeight(float &weight) {
  float total = 0;
  float minimum = 1000000.0f;
  float maximum = -1000000.0f;

  for (int i = 0; i < 5; i++) {
    if (!scale.wait_ready_timeout(1500)) return false;
    float v = scale.get_units(5);
    if (!isfinite(v)) return false;
    total += v;
    if (v < minimum) minimum = v;
    if (v > maximum) maximum = v;
    delay(100);
  }

  weight = total / 5.0f;
  return (maximum - minimum) <= STABILITY_SPREAD_G;
}

bool httpPost(const String &path, const String &json, String &body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(2500);
  if (!http.begin(client, String(API_ROOT) + path)) return false;
  http.addHeader("Content-Type", "application/json");
  int response = http.POST(json);
  body = response > 0 ? http.getString() : "";
  Serial.printf("POST %s => HTTP %d\n", path.c_str(), response);
  http.end();
  return response == 200;
}

bool fetchPending(String &commandId, String &condition) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(2500);
  if (!http.begin(client, String(API_ROOT) + "/hardware/perintah")) return false;
  int code = http.GET();
  String response = code == 200 ? http.getString() : "";
  http.end();
  if (code != 200) return false;

  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  if (doc["perintah"].isNull()) return false;

  String status = doc["perintah"]["status"].as<String>();
  commandId = doc["perintah"]["id"].as<String>();
  condition = doc["perintah"]["kondisi_visual"].as<String>();

  if (status != "MENUNGGU_ESP32") return false;
  if (commandId.isEmpty() || commandId == lastExecutedId) return false;
  return condition == "GOOD" || condition == "BAD";
}

int sortServoIndex(float grams) {
  if (grams <= 50.0f) return 1;   // servo 2: kecil
  if (grams <= 100.0f) return 2;  // servo 3: sedang
  if (grams <= 300.0f) return 3;  // servo 4: besar
  return 4;                       // servo 5: sangat besar
}

void pushToConveyor() {
  Serial.println("Servo 1 mendorong kentang");
  moveSlow(0, REST_ANGLE, PUSH_ANGLE);
  delay(700);
  moveSlow(0, PUSH_ANGLE, REST_ANGLE);
  delay(300);
}

void sortPhysical(const String &condition, float weight) {
  pushToConveyor();
  motorForward();
  Serial.println("Konveyor berjalan");

  if (condition == "BAD") {
    Serial.println("BAD -> wadah reject, servo 2-5 diam");
    delay(TIME_TO_REJECT_MS);
  } else {
    int servoIndex = sortServoIndex(weight);
    Serial.printf("GOOD %.2f g -> Servo %d\n", weight, servoIndex + 1);
    delay(TIME_TO_SERVO_MS[servoIndex - 1]);
    moveSlow(servoIndex, REST_ANGLE, SORT_ANGLE);
    delay(800);
    moveSlow(servoIndex, SORT_ANGLE, REST_ANGLE);
    delay(CONVEYOR_EXTRA_MS);
  }

  motorStop();
  Serial.println("Konveyor berhenti, sortir selesai");
}

void setup() {
  Serial.begin(115200);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENA, OUTPUT);
  motorStop();

  for (int i = 0; i < 5; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PINS[i], 500, 2400);
    servos[i].write(REST_ANGLE);
    delay(300);
  }

  scale.begin(HX_DOUT, HX_SCK);
  if (!scale.wait_ready_timeout(3000)) {
    Serial.println("HX711 TIDAK TERDETEKSI. Periksa kabel.");
    while (true) delay(1000);
  }
  scale.set_scale(CALIBRATION_FACTOR);
  Serial.println("KOSONGKAN timbangan untuk tare (3 detik)...");
  delay(3000);
  scale.tare(20);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Menghubungkan Wi-Fi...");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 12000) delay(300);
  Serial.println(WiFi.status() == WL_CONNECTED ? "Wi-Fi terhubung" : "Wi-Fi offline");
  Serial.println("POPTATO SIAP. Foto via dashboard, lalu timbang SATU kentang.");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastRetry = 0;
    if (millis() - lastRetry > 10000) {
      WiFi.reconnect();
      lastRetry = millis();
    }
    delay(200);
    return; // no CNN authorization => no movement
  }

  if (waitingForEmpty) {
    float remaining;
    if (readStableWeight(remaining) && abs(remaining) < MIN_WEIGHT_G) {
      waitingForEmpty = false;
      Serial.println("Timbangan kosong, siap menerima kentang berikutnya.");
    }
    delay(200);
    return;
  }

  if (millis() - lastPollMs < POLL_MS) return;
  lastPollMs = millis();

  String commandId, condition;
  if (!fetchPending(commandId, condition)) return;

  // The photo result is available; next wait for the SAME potato on HX711.
  float weight;
  if (!readStableWeight(weight) || weight < MIN_WEIGHT_G) {
    Serial.println("CNN siap; menunggu berat kentang stabil di HX711...");
    return;
  }

  // Claim first, so simultaneous ESP32s cannot execute the same command.
  String response;
  if (!httpPost("/hardware/perintah/" + commandId + "/mulai", "{}", response)) {
    Serial.println("Klaim perintah gagal - mekanisme TIDAK dijalankan");
    return;
  }
  lastExecutedId = commandId;

  // Update existing React monitoring endpoint.
  String weightJson = "{\"berat_gram\":" + String(weight, 2) + "}";
  if (!httpPost("/hardware/berat", weightJson, response)) {
    Serial.println("Peringatan: monitoring berat tidak terkirim, sortir berlanjut");
  }

  Serial.printf("Perintah %s | %s | %.2f gram\n", commandId.c_str(), condition.c_str(), weight);
  sortPhysical(condition, weight);

  // A confirmed physical run is never automatically replayed on HTTP failure.
  String finishedJson = "{\"id\":\"" + commandId + "\",\"berat_gram\":" + String(weight, 2) + "}";
  if (!httpPost("/hardware/perintah/selesai", finishedJson, response)) {
    Serial.println("PERINGATAN: selesai gagal dicatat. Perintah DIPROSES di API; periksa manual.");
  } else {
    Serial.println("Database/command diperbarui: SELESAI");
  }

  waitingForEmpty = true;
  delay(500);
}
