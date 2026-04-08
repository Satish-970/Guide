# CityCare Microservices — Circuit Breaker & Token Propagation Implementation Guide

> **Audit date:** April 2026  
> **Stack:** Spring Boot 3.3.4 · Spring Cloud 2023.0.3 · OpenFeign · Resilience4j · Java 21

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Issues Found](#2-issues-found)
3. [Step-by-Step: Add Resilience4j to Every Service](#3-step-by-step-add-resilience4j-to-every-service)
4. [Step-by-Step: Fix Circuit Breaker Wiring](#4-step-by-step-fix-circuit-breaker-wiring)
5. [Step-by-Step: Fix Token Propagation](#5-step-by-step-fix-token-propagation)
6. [Step-by-Step: Fix API Gateway Route Gaps](#6-step-by-step-fix-api-gateway-route-gaps)
7. [Config-Server Properties to Add](#7-config-server-properties-to-add)
8. [Service-by-Service Checklist](#8-service-by-service-checklist)
9. [Quick Verification Commands](#9-quick-verification-commands)

---

## 1. Current State Audit

### 1.1 Services and Their Feign Dependencies

| Service | Port | Feign Clients | Fallbacks Present |
|---|---|---|---|
| **api-gateway** | 8080 | none (gateway) | N/A |
| **auth-service** | 8081 | `CitizenClient` | ✅ `CitizenClientFallback` |
| **citizen-service** | 8082 | none (no outgoing calls) | N/A |
| **emergency-service** | 8083 | `CitizenClient` | ✅ `CitizenClientFallback` |
| **patient-treatment-service** | 8084 | `CitizenClient`, `EmergencyClient` | ✅ both |
| **facility-service** | 8085 | `AuthClient` | ✅ `AuthClientFallback` |
| **compliance-service** | 8086 | `FacilityClient`, `PatientClient`, `EmergencyClient` | ✅ all three |

### 1.2 JWT / Token Flow (as-is)

The API gateway (`JwtAuthFilter`) validates JWTs and injects `X-Auth-User` (username) but **does NOT inject `X-User-Role`** into downstream headers. Downstream services read `X-User-Role` from the request to build the `SecurityContext`. This means role-based `@PreAuthorize` checks downstream always fall back to `CITIZEN` for real traffic coming through the gateway.

### 1.3 Resilience4j Dependency (as-is)

**No service has `spring-cloud-starter-circuitbreaker-resilience4j` in its `pom.xml`.** All services have `spring.cloud.openfeign.circuitbreaker.enabled=true` in their config-server properties, but without the Resilience4j starter on the classpath, Spring Cloud cannot activate a circuit breaker factory — the property is silently ignored and fallbacks never fire.

---

## 2. Issues Found

### Issue 1 — Missing Resilience4j Dependency (ALL 5 Feign services)

`spring-cloud-starter-circuitbreaker-resilience4j` is absent from the `pom.xml` of every service that uses OpenFeign. The `spring.cloud.openfeign.circuitbreaker.enabled=true` property only takes effect when this starter is on the classpath. Without it, Feign uses a no-op circuit breaker factory — fallbacks defined in `@FeignClient(fallback = ...)` are **never invoked**.

**Affected:** `auth-service`, `emergency-service`, `patient-treatment-service`, `facility-service`, `compliance-service`

---

### Issue 2 — `X-User-Role` Not Forwarded by API Gateway

`JwtAuthFilter` extracts the username and adds `X-Auth-User` to the forwarded request, but the JWT's role/authorities claim is never extracted or forwarded as an `X-User-Role` header. Every downstream service reads `X-User-Role` to assign a `GrantedAuthority`:

```java
// citizen-service SecurityConfig (and others)
String role = (roleHeader != null) ? roleHeader : "CITIZEN";
```

Because the gateway never sets this header, every authenticated user is treated as `ROLE_CITIZEN` downstream, making `ADMIN`/`DOCTOR`/`NURSE` role guards ineffective for external requests.

---

### Issue 3 — Feign URL Path Mismatch (compliance-service & patient-treatment-service)

Feign clients resolve against the target service's Eureka name using the path exactly as coded. Several clients use paths that include `/api` prefix (matching the target service's `context-path`) while others omit it — and this is inconsistently applied.

**Examples:**
- `compliance-service → FacilityClient`: calls `/api/facilities/{id}` ✅ correct (facility-service uses `/api` context-path)
- `compliance-service → PatientClient`: calls `/api/patients/{id}` ✅ correct
- `compliance-service → EmergencyClient`: calls `/api/emergencies/{id}` ✅ correct
- `patient-treatment-service → CitizenClient`: calls `/citizens/{id}` ❌ missing `/api` prefix (citizen-service runs at `/api`)
- `patient-treatment-service → EmergencyClient`: calls `/emergencies/{id}` ❌ missing `/api` prefix
- `emergency-service → CitizenClient`: calls `/citizens/{id}` ❌ missing `/api` prefix

This means Feign calls from patient-treatment-service and emergency-service to citizen-service and emergency-service will return 404 in production even if services are up. Fallbacks will fire for the wrong reason, masking the bug.

---

### Issue 4 — Internal Endpoint Not Routed Through Gateway

The `auth-service` calls `citizen-service` at `/api/citizens/internal/create` via Feign. This is a direct service-to-service call (via Eureka), so it bypasses the API gateway — which is **intentional and correct** for internal calls. However, the `/citizens/internal/**` path is exposed on citizen-service with `.permitAll()` and no authentication. Any service inside the cluster (or any process that can reach port 8082) can call it without a JWT. This is an internal security gap.

---

### Issue 5 — `auth-service` Missing OpenFeign Dependency

`auth-service` uses `@EnableFeignClients` and `CitizenClient`, but its `pom.xml` does **not** include `spring-cloud-starter-openfeign`. It works only if it happens to be on the classpath transitively — which is not guaranteed and will fail in a clean build.

---

### Issue 6 — No Resilience4j Config in Config-Server

`spring.cloud.openfeign.circuitbreaker.enabled=true` is present in each service's config-server properties, but no `resilience4j.circuitbreaker.*` tuning properties exist anywhere. With default settings the circuit breaker trips after 100 calls in a 100-call sliding window — far too high for a development/staging system and not appropriate for production healthcare workloads.

---

## 3. Step-by-Step: Add Resilience4j to Every Service

Add the following dependency to the `<dependencies>` block of **each of these five services**: `auth-service`, `citizen-service`, `emergency-service`, `patient-treatment-service`, `facility-service`, `compliance-service`.

> `citizen-service` has no outgoing Feign calls right now but add it anyway so it is ready if calls are added later.

```xml
<!-- pom.xml of each service — inside <dependencies> -->
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-circuitbreaker-resilience4j</artifactId>
</dependency>
```

Also add OpenFeign explicitly to `auth-service` (currently missing):

```xml
<!-- auth-service pom.xml — inside <dependencies> -->
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
```

Both are managed by `spring-cloud-dependencies` BOM already present in each pom, so **no version tag is needed**.

---

## 4. Step-by-Step: Fix Circuit Breaker Wiring

### 4.1 Verify `@EnableFeignClients` is on each main class

All five services already have `@EnableFeignClients` on their `@SpringBootApplication` class — no change needed there.

### 4.2 Fix Fallback registration for auth-service

`auth-service`'s `CitizenClientFallback` returns `null` from `createCitizenProfile`. This is fine as a degraded response, but add a `@Slf4j` log so it is observable:

**File:** `auth-service/src/main/java/com/citycare/authservice/feign/CitizenClientFallback.java`

```java
@Slf4j
@Component
public class CitizenClientFallback implements CitizenClient {

    @Override
    public CitizenResponse createCitizenProfile(CitizenCreateRequest request) {
        log.warn("[CircuitBreaker] citizen-service unavailable — citizen profile for userId={} " +
                 "will not be auto-created. User can create it later via /api/citizens/profile",
                 request.getUserId());
        return null;
    }
}
```

### 4.3 Expose circuit breaker health in Actuator for all services

Add this to the shared `application.properties` in config-server (see Section 7):

```properties
management.endpoints.web.exposure.include=health,info,metrics,circuitbreakers
management.endpoint.health.show-details=always
management.health.circuitbreakers.enabled=true
```

### 4.4 Add `FallbackFactory` support (recommended upgrade path)

The current fallbacks implement the Feign interface directly. This means they cannot access the *cause* of the failure. For production observability, upgrade each fallback to use `FallbackFactory` so you can log the actual exception. Example for `patient-treatment-service`:

**File:** `patient-treatment-service/src/main/java/com/citycare/patientservice/feign/EmergencyClientFallbackFactory.java`  
*(create this new file)*

```java
package com.citycare.patientservice.feign;

import com.citycare.patientservice.feign.dto.EmergencyResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cloud.openfeign.FallbackFactory;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class EmergencyClientFallbackFactory implements FallbackFactory<EmergencyClient> {

    @Override
    public EmergencyClient create(Throwable cause) {
        return new EmergencyClient() {
            @Override
            public EmergencyResponse getEmergencyById(Long emergencyId) {
                log.error("[CircuitBreaker] emergency-service call failed for id={}: {}",
                        emergencyId, cause.getMessage());
                EmergencyResponse r = new EmergencyResponse();
                r.setEmergencyId(emergencyId);
                r.setStatus("UNKNOWN");
                return r;
            }

            @Override
            public EmergencyResponse updateEmergencyStatus(Long emergencyId, String status) {
                log.error("[CircuitBreaker] emergency-service status update failed for id={}: {}",
                        emergencyId, cause.getMessage());
                EmergencyResponse r = new EmergencyResponse();
                r.setEmergencyId(emergencyId);
                r.setStatus(status);
                return r;
            }
        };
    }
}
```

Then update the `@FeignClient` annotation:

```java
// Before
@FeignClient(name = "emergency-service", fallback = EmergencyClientFallback.class)

// After
@FeignClient(name = "emergency-service", fallbackFactory = EmergencyClientFallbackFactory.class)
```

Apply the same pattern to all other Feign clients in all services. The old `*Fallback.java` classes can be deleted once the factory versions are in place.

---

## 5. Step-by-Step: Fix Token Propagation

### 5.1 Extract role claim from JWT in the API Gateway

The JWT issued by `auth-service` must contain a `role` claim. Verify `auth-service` includes it (check `JwtService`/`JwtUtil` in auth-service when generating tokens — add `claim("role", user.getRole().name())` if not already present).

Then update `JwtAuthFilter` in `api-gateway` to extract and forward the role:

**File:** `api-gateway/src/main/java/com/citycare/apigateway/filter/JwtAuthFilter.java`

Replace the section that builds the mutated request:

```java
// EXISTING — only forwards username
String username = jwtUtil.extractUsername(token);
ServerHttpRequest mutatedRequest = request.mutate()
        .header("X-Auth-User", username)
        .build();

// REPLACE WITH — also forward role
String username = jwtUtil.extractUsername(token);
String role = jwtUtil.extractRole(token);   // add this method to JwtUtil
ServerHttpRequest mutatedRequest = request.mutate()
        .header("X-Auth-User", username)
        .header("X-User-Role", role != null ? role : "CITIZEN")
        .build();
```

**File:** `api-gateway/src/main/java/com/citycare/apigateway/filter/JwtUtil.java`

Add the `extractRole` method:

```java
public String extractRole(String token) {
    Claims claims = extractAllClaims(token);
    Object role = claims.get("role");
    return role != null ? role.toString() : null;
}
```

### 5.2 Ensure Feign propagates both Authorization and X-User-Role headers

All five `FeignConfig.java` files only forward `Authorization`. Update each one to also forward `X-User-Role`:

**File:** `*/feign/FeignConfig.java` — applies identically to all five services

```java
@Bean
public RequestInterceptor requestInterceptor() {
    return (RequestTemplate template) -> {
        ServletRequestAttributes attrs =
                (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attrs != null) {
            HttpServletRequest request = attrs.getRequest();

            String auth = request.getHeader("Authorization");
            if (auth != null && !auth.isBlank()) {
                template.header("Authorization", auth);
            }

            String role = request.getHeader("X-User-Role");
            if (role != null && !role.isBlank()) {
                template.header("X-User-Role", role);
            }

            String user = request.getHeader("X-Auth-User");
            if (user != null && !user.isBlank()) {
                template.header("X-Auth-User", user);
            }
        }
    };
}
```

This ensures that when `patient-treatment-service` (for example) calls `citizen-service` via Feign, both the JWT and the role header travel with the request so citizen-service's `SecurityConfig` builds the correct `SecurityContext`.

### 5.3 Protect internal endpoints with a shared secret header (Issue 4 fix)

The `/citizens/internal/**` endpoint is `.permitAll()`, meaning any caller inside the cluster (or external if the port is reachable) can invoke it without a JWT. Add a lightweight internal shared secret check.

**Step A — Add the secret to config-server's `application.properties`:**

```properties
internal.api.secret=<generate a strong random value, e.g. UUID>
```

**Step B — In `citizen-service` `InternalCitizenController`, add a header check:**

```java
@PostMapping("/create")
public ResponseEntity<ApiResponse<Citizen>> createCitizenFromRegistration(
        @RequestHeader("X-Internal-Secret") String secret,
        @Valid @RequestBody CitizenInternalCreateRequest request) {

    if (!internalSecret.equals(secret)) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(ApiResponse.error("Forbidden"));
    }
    // ... existing logic
}
```

**Step C — In `auth-service` `FeignConfig`, also forward the internal secret:**

```java
String internalSecret = environment.getProperty("internal.api.secret");
if (internalSecret != null) {
    template.header("X-Internal-Secret", internalSecret);
}
```

---

## 6. Step-by-Step: Fix API Gateway Route Gaps

### 6.1 Fix missing `/citizens/internal/**` route

The gateway's `api-gateway.properties` currently routes `/citizens/**` to `citizen-service`. Internal Feign calls go directly via Eureka (not through the gateway), which is fine — but this means the gateway has **no filter** for internal paths. Confirm in `api-gateway.properties` that you do NOT add an external route for `/citizens/internal/**`. Instead, enforce the shared secret (Section 5.3) for all direct internal calls.

### 6.2 Add the `JwtAuthFilter` to all routes

Currently `api-gateway.properties` defines routes but none of them explicitly apply the `JwtAuthFilter`. In Spring Cloud Gateway the filter must be declared either globally (defaultFilters) or per-route. Add a global default filter in `api-gateway.properties`:

```properties
# config-server/src/main/resources/config/api-gateway.properties

# Apply JWT auth globally to all routes
spring.cloud.gateway.default-filters[0]=JwtAuthFilter
```

This ensures every route goes through JWT validation, not just routes that happen to be tested with a token.

### 6.3 Add missing routes for admin endpoints

`auth-service` exposes `/api/admin/**` but the gateway route for `/admin/**` points to `auth-service` without a context-path adjustment. Since `auth-service` runs at `server.servlet.context-path=/api`, the full path on the service is `/api/admin/**`. The gateway receives `/admin/**` and must strip the prefix or add `/api`. Fix:

```properties
# In api-gateway.properties replace:
spring.cloud.gateway.routes[6].id=admin-auth
spring.cloud.gateway.routes[6].uri=lb://auth-service
spring.cloud.gateway.routes[6].predicates[0]=Path=/admin/**

# With:
spring.cloud.gateway.routes[6].id=admin-auth
spring.cloud.gateway.routes[6].uri=lb://auth-service
spring.cloud.gateway.routes[6].predicates[0]=Path=/admin/**
spring.cloud.gateway.routes[6].filters[0]=AddRequestHeader=X-User-Role, ADMIN
spring.cloud.gateway.routes[6].filters[1]=RewritePath=/admin/(?<segment>.*), /api/admin/${segment}
```

Similarly verify all other routes: since all services use `server.servlet.context-path=/api`, the gateway routes should either rewrite paths or the predicates should match the full `/api/**` pattern:

```properties
# Option A (recommended): Keep short external paths, rewrite to include /api
spring.cloud.gateway.routes[1].id=citizen-service
spring.cloud.gateway.routes[1].uri=lb://citizen-service
spring.cloud.gateway.routes[1].predicates[0]=Path=/citizens/**
spring.cloud.gateway.routes[1].filters[0]=RewritePath=/citizens/(?<segment>.*), /api/citizens/${segment}

# Repeat for emergency, patient, facility, compliance, auth routes
```

> **Important:** If services already work without rewrite, it means `context-path` is being handled differently. Verify by checking what path actually reaches a service controller. The safest approach is to test one route's access log against the `context-path` setting.

---

## 7. Config-Server Properties to Add

### `config-server/src/main/resources/config/application.properties` (shared across all services)

```properties
# ── Circuit Breaker – Resilience4j Shared Defaults ──────────────────────────
resilience4j.circuitbreaker.configs.default.sliding-window-type=COUNT_BASED
resilience4j.circuitbreaker.configs.default.sliding-window-size=10
resilience4j.circuitbreaker.configs.default.minimum-number-of-calls=5
resilience4j.circuitbreaker.configs.default.failure-rate-threshold=50
resilience4j.circuitbreaker.configs.default.wait-duration-in-open-state=10s
resilience4j.circuitbreaker.configs.default.permitted-number-of-calls-in-half-open-state=3
resilience4j.circuitbreaker.configs.default.automatic-transition-from-open-to-half-open-enabled=true
resilience4j.circuitbreaker.configs.default.record-exceptions=java.io.IOException,java.util.concurrent.TimeoutException,feign.FeignException

# ── Resilience4j Retry Defaults ─────────────────────────────────────────────
resilience4j.retry.configs.default.max-attempts=3
resilience4j.retry.configs.default.wait-duration=500ms
resilience4j.retry.configs.default.retry-exceptions=java.io.IOException,feign.RetryableException

# ── Feign Timeout Defaults ───────────────────────────────────────────────────
spring.cloud.openfeign.client.config.default.connect-timeout=3000
spring.cloud.openfeign.client.config.default.read-timeout=5000

# ── Actuator: expose circuit breaker endpoints ───────────────────────────────
management.endpoints.web.exposure.include=health,info,metrics,circuitbreakers,circuitbreakerevents
management.endpoint.health.show-details=always
management.health.circuitbreakers.enabled=true

# ── Internal Secret ──────────────────────────────────────────────────────────
internal.api.secret=REPLACE_WITH_STRONG_RANDOM_UUID
```

### Per-service instance config (example for `patient-treatment-service.properties`)

```properties
# Named circuit breaker instances that match Feign client names
resilience4j.circuitbreaker.instances.citizen-service.base-config=default
resilience4j.circuitbreaker.instances.emergency-service.base-config=default
# Override: emergency calls are more critical, use tighter threshold
resilience4j.circuitbreaker.instances.emergency-service.failure-rate-threshold=30
resilience4j.circuitbreaker.instances.emergency-service.wait-duration-in-open-state=15s
```

Add similar named-instance blocks to each service's config-server properties file, with instance names matching the `name =` value in each `@FeignClient` annotation.

---

## 8. Service-by-Service Checklist

### `api-gateway`
- [ ] Add `extractRole(token)` to `JwtUtil`
- [ ] Update `JwtAuthFilter` to forward `X-User-Role` header downstream
- [ ] Add `spring.cloud.gateway.default-filters[0]=JwtAuthFilter` to `api-gateway.properties`
- [ ] Add `RewritePath` filters to all routes to correctly prepend `/api` context-path
- [ ] Fix `/admin/**` route to rewrite path to `/api/admin/**`

### `auth-service`
- [ ] Add `spring-cloud-starter-openfeign` dependency to `pom.xml`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] Add `@Slf4j` to `CitizenClientFallback` and log the degraded path
- [ ] (Optional but recommended) Replace fallback class with `CitizenClientFallbackFactory`
- [ ] Update `FeignConfig` to also forward `X-User-Role` and `X-Auth-User` headers
- [ ] Add `X-Internal-Secret` header forwarding to `FeignConfig` for internal calls
- [ ] Add Resilience4j named instance config to `auth-service.properties` in config-server

### `citizen-service`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] Add `X-Internal-Secret` header validation to `InternalCitizenController`
- [ ] Update `SecurityConfig` to also accept `X-User-Role` forwarded header from gateway
- [ ] Add Resilience4j config to `citizen-service.properties` in config-server

### `emergency-service`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] **Fix Feign path bug:** `CitizenClient` calls `/citizens/{id}` — must be `/api/citizens/{id}`
  - File: `emergency-service/src/main/java/com/citycare/emergencyservice/feign/CitizenClient.java`
  - Change `@GetMapping("/citizens/{id}")` → `@GetMapping("/api/citizens/{id}")`
  - Change `@GetMapping("/citizens/user/{userId}")` → `@GetMapping("/api/citizens/user/{userId}")`
- [ ] Replace `CitizenClientFallback` with `CitizenClientFallbackFactory` (for cause logging)
- [ ] Update `FeignConfig` to also forward `X-User-Role` and `X-Auth-User`
- [ ] Add Resilience4j named instance config to `emergency-service.properties` in config-server

### `patient-treatment-service`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] **Fix Feign path bug:** `CitizenClient` calls `/citizens/{id}` — must be `/api/citizens/{id}`
  - File: `patient-treatment-service/src/main/java/com/citycare/patientservice/feign/CitizenClient.java`
  - Change `@GetMapping("/citizens/{id}")` → `@GetMapping("/api/citizens/{id}")`
- [ ] **Fix Feign path bug:** `EmergencyClient` calls `/emergencies/{id}` — must be `/api/emergencies/{id}`
  - File: `patient-treatment-service/src/main/java/com/citycare/patientservice/feign/EmergencyClient.java`
  - Change `@GetMapping("/emergencies/{id}")` → `@GetMapping("/api/emergencies/{id}")`
  - Change `@PatchMapping("/emergencies/{id}/status")` → `@PatchMapping("/api/emergencies/{id}/status")`
- [ ] Replace `CitizenClientFallback` and `EmergencyClientFallback` with factory versions
- [ ] Update `FeignConfig` to also forward `X-User-Role` and `X-Auth-User`
- [ ] Add Resilience4j named instance config to `patient-treatment-service.properties` in config-server

### `facility-service`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] Replace `AuthClientFallback` with `AuthClientFallbackFactory`
- [ ] Update `FeignConfig` to also forward `X-User-Role` and `X-Auth-User`
- [ ] Add Resilience4j named instance config to `facility-service.properties` in config-server

### `compliance-service`
- [ ] Add `spring-cloud-starter-circuitbreaker-resilience4j` dependency to `pom.xml`
- [ ] Replace all three fallbacks with factory versions (`FacilityClientFallbackFactory`, `PatientClientFallbackFactory`, `EmergencyClientFallbackFactory`)
- [ ] Update `FeignConfig` to also forward `X-User-Role` and `X-Auth-User`
- [ ] Add Resilience4j named instance config to `compliance-service.properties` in config-server

---

## 9. Quick Verification Commands

After making all changes, use these to confirm the circuit breaker is active and tokens flow correctly.

### Confirm Resilience4j is loaded
```bash
# Should list circuit breaker names for each service
curl http://localhost:8084/actuator/circuitbreakers | jq .

# Should show CLOSED state with call stats
curl http://localhost:8084/actuator/health | jq '.components.circuitBreakers'
```

### Confirm role is forwarded through gateway
```bash
# 1. Login and get token
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@citycare.com","password":"password"}' | jq -r '.token')

# 2. Call an ADMIN-only endpoint through the gateway — should succeed
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/admin/users/1

# 3. Call with a CITIZEN token — should return 403
curl -H "Authorization: Bearer $CITIZEN_TOKEN" http://localhost:8080/admin/users/1
```

### Simulate circuit breaker opening
```bash
# Stop citizen-service, then make repeated Feign calls via patient-treatment-service
# After 5+ failures the circuit should open and fallback responses return immediately
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/patients/1
# Should return a response with citizenName="Unknown (citizen-service unavailable)"
# and circuit breaker state should become OPEN in actuator
curl http://localhost:8084/actuator/circuitbreakers | jq '.circuitBreakers["citizen-service"].state'
```

### Confirm internal paths go direct (not through gateway)
```bash
# This should FAIL at the gateway (no route for /api/citizens/internal/**)
curl -X POST http://localhost:8080/api/citizens/internal/create \
  -H "Content-Type: application/json" \
  -d '{"userId":99,"name":"Test","contactInfo":"1234567890"}'
# Expected: 404 from gateway (no matching route) — confirming internal calls bypass gateway correctly
```

---

## Summary of Priority Order

1. **Highest priority — add Resilience4j dependency** to all five Feign-using services (nothing else works without this)
2. **High priority — fix Feign path bugs** in `emergency-service` and `patient-treatment-service` (causes silent 404 fallbacks masking real failures)
3. **High priority — forward `X-User-Role` from gateway** (role-based access control is broken for all non-CITIZEN roles)
4. **Medium priority — upgrade fallbacks to `FallbackFactory`** (improves observability and debugging)
5. **Medium priority — add Resilience4j tuning properties** to config-server (defaults are too permissive for healthcare)
6. **Lower priority — add internal secret protection** on `/citizens/internal/**` (security hardening)
7. **Lower priority — add RewritePath filters** to gateway routes (depends on whether context-path is already handled)
